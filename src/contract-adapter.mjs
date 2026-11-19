// Unified request/response contract normalization across extension tools and proxied official tools.
// Eliminates cross-tool schema drift (intention, instance_id vs project_path) and catches high-frequency
// edit_by_dsl / official argument mistakes locally with actionable diagnostics.

const COMMON_KEY_HINTS = {
  lines: ['count', 'limit'],
  keyword: ['query', 'q'],
  keywords: ['query', 'queries'],
  targets: ['guids', 'object_paths'],
  target: ['guid', 'object_path'],
  video_name: ['videos'],
  limit: ['count'],
  component: ['guid'],
};

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Extracts `intention` for call logging and normalizes it according to the target tool's schema:
// - Own tools always strip `intention` (their schemas are strictObject and never declare it).
// - Official tools keep `intention` when declared or open-schema, strip it when rejected by a strict
//   schema, and auto-fill a default when the official schema requires it.
export function normalizeIntention(args, { isOwn = false, officialSchema } = {}) {
  const src = isPlainObject(args) ? args : {};
  const hasIntention = Object.hasOwn(src, 'intention');
  const intention = typeof src.intention === 'string' && src.intention.trim() ? src.intention.trim() : undefined;

  if (isOwn) {
    if (!hasIntention) return { args: src, intention };
    const { intention: _drop, ...rest } = src;
    return { args: rest, intention };
  }

  const props = officialSchema?.properties;
  const required = Array.isArray(officialSchema?.required) ? officialSchema.required : [];
  const declaresIntention = Boolean(props && Object.hasOwn(props, 'intention'));
  const strictRejects = Boolean(props && !declaresIntention && officialSchema?.additionalProperties === false);

  if (hasIntention && strictRejects) {
    const { intention: _drop, ...rest } = src;
    return { args: rest, intention };
  }
  if (!hasIntention && required.includes('intention')) {
    return { args: { ...src, intention: 'MCP tool call' }, intention: 'MCP tool call' };
  }
  return { args: src, intention };
}

function hintForKey(badKey, validKeys) {
  const candidates = COMMON_KEY_HINTS[badKey] || [];
  const hit = candidates.find((k) => validKeys.includes(k));
  return hit ? ` (did you mean "${hit}"?)` : '';
}

// Normalizes and pre-validates arguments before forwarding to an official MCP tool:
// 1. Resolves project_path -> instance_id when the official tool expects instance_id.
// 2. Auto-fills instance_id when exactly one editor project window is open (matching extension tools),
//    or returns a clear AMBIGUOUS_INSTANCE / NO_OPEN_PROJECT error instead of the official gateway's
//    misleading "Unknown gateway MCP tool" (-32601).
// 3. Checks missing required keys and strict unrecognized keys against the cached official inputSchema.
export async function normalizeOfficialArgs(name, args, { officialSchema, resolveInstanceId, listOpenInstances } = {}) {
  const out = isPlainObject(args) ? { ...args } : {};
  const props = officialSchema?.properties;
  const required = Array.isArray(officialSchema?.required) ? officialSchema.required : [];
  const validKeys = props ? Object.keys(props) : [];

  const takesInstance = Boolean(props && Object.hasOwn(props, 'instance_id'));
  const takesProjectPath = Boolean(props && Object.hasOwn(props, 'project_path'));

  if (takesInstance) {
    if (out.instance_id === undefined && typeof out.project_path === 'string' && out.project_path.trim()) {
      if (resolveInstanceId) {
        out.instance_id = String(await resolveInstanceId({ project_path: out.project_path }));
      }
      if (!takesProjectPath) delete out.project_path;
    } else if (out.instance_id === undefined) {
      const open = listOpenInstances ? await listOpenInstances() : [];
      if (open.length === 1) {
        out.instance_id = String(open[0].instance_id);
      } else if (required.includes('instance_id')) {
        if (open.length === 0) {
          throw Error(`NO_OPEN_PROJECT(${name}): no open Xiangsu editor project window; open one with project_open or project_new first`);
        }
        const desc = open.map((i) => `${i.instance_id}=${i.project_path || '(unsaved)'}`).join(', ');
        throw Error(`AMBIGUOUS_INSTANCE(${name}): ${open.length} editor windows are open (${desc}); pass instance_id or project_path`);
      }
    } else if (out.project_path !== undefined && !takesProjectPath && officialSchema?.additionalProperties === false) {
      delete out.project_path;
    }
  }

  if (props) {
    const missing = required.filter((k) => out[k] === undefined);
    if (missing.length) {
      throw Error(`INVALID_ARGUMENTS(${name}): missing required ${missing.join(', ')} (accepted keys: ${validKeys.join(', ')})`);
    }
    if (officialSchema?.additionalProperties === false) {
      const unknown = Object.keys(out).filter((k) => !Object.hasOwn(props, k));
      if (unknown.length) {
        const detail = unknown.map((k) => `"${k}"${hintForKey(k, validKeys)}`).join(', ');
        throw Error(`INVALID_ARGUMENTS(${name}): unrecognized key(s) ${detail} (accepted keys: ${validKeys.join(', ')})`);
      }
    }
  }

  return out;
}

// Static pre-check for edit_by_dsl batches before hitting the editor, catching the highest-frequency
// mistakes observed in server.log so an entire 10-27 command batch is not wasted on command[0].
export function precheckEditByDsl(commands) {
  if (!Array.isArray(commands)) return;
  for (const [i, c] of commands.entries()) {
    if (!isPlainObject(c)) {
      throw Error(`INVALID_ARGUMENTS(edit_by_dsl): commands[${i}] must be an object with command_type and params`);
    }
    if (c.command_type === 'set_component') {
      const p = c.params;
      if (Array.isArray(p?.properties)) {
        throw Error(`INVALID_ARGUMENTS(edit_by_dsl): commands[${i}] set_component properties must be an object such as {"intensity": 0.5}, not an array`);
      }
      if (p && p.guid === undefined && p.component !== undefined) {
        throw Error(`INVALID_ARGUMENTS(edit_by_dsl): commands[${i}] set_component uses "guid" (not "component") for the target component GUID`);
      }
      if (typeof p?.guid === 'string' && /^s\d+$/.test(p.guid)) {
        throw Error(
          `INVALID_ARGUMENTS(edit_by_dsl): commands[${i}] set_component guid "${p.guid}" is a scene object GUID (sNN), not a component GUID (cNN); pass a component GUID from inspect or {"$ref": "${p.guid}", "component_type": "<Type>"}`,
        );
      }
    }
  }
}

// Picked: keeps ordinary batch outputs intact while compacting 20-46 KB import/script echo payloads.
export const DSL_COMPACT_CHARS = 8000;

function compactResultItem(item) {
  if (!isPlainObject(item)) return item;
  const slim = {};
  for (const k of ['command_type', 'status', 'alias', 'error']) {
    if (item[k] !== undefined) slim[k] = item[k];
  }
  const r = item.result;
  if (isPlainObject(r)) {
    const keep = {};
    for (const k of ['guid', 'object_guid', 'component_guid', 'resource_guid', 'path', 'name', 'changes', 'created', 'updated']) {
      if (r[k] !== undefined) keep[k] = r[k];
    }
    if (Object.keys(keep).length) slim.result = keep;
  } else if (r !== undefined && typeof r !== 'object') {
    slim.result = r;
  }
  return slim;
}

export function compactEditByDslResult(res, { maxChars = DSL_COMPACT_CHARS } = {}) {
  if (!res || res.isError || !Array.isArray(res.content) || !res.content.every((c) => c.type === 'text')) return res;
  const body = res.content.map((c) => c.text).join('\n');
  if (body.length <= maxChars) return res;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    return res;
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) return res;
  const compacted = {
    success: parsed.success,
    status: parsed.status,
    executed: parsed.executed,
    failed: parsed.failed,
    skipped: parsed.skipped,
    compacted: true,
    original_chars: body.length,
    results: parsed.results.map(compactResultItem),
  };
  return { content: [{ type: 'text', text: JSON.stringify(compacted, null, 2) }] };
}
