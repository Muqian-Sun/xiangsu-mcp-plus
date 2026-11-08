// Client side of the editor plugin RPC: discovers live plugin instances and calls them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const INSTANCE_DIR = path.join(process.env.XIANGSU_MCP_EXT_STATE || path.join(os.homedir(), '.xiangsu-mcp-ext'), 'instances');

// Start time (ms, truncated to the second) of each running pid; pids with no process are absent.
function startTimes(pids) {
  let out;
  try {
    out = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  } catch (e) {
    if (e.status === 1 && !String(e.stdout).trim()) return new Map();
    throw e;
  }
  const times = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!m) continue;
    const t = Date.parse(m[2]);
    if (Number.isNaN(t)) throw Error(`PS_LSTART_UNPARSED: ${line}`);
    times.set(Number(m[1]), t);
  }
  return times;
}

// A record left by a window that exited without cleaning up must not match whatever process reuses
// its pid later, so the process has to have started no later than the plugin wrote the record.
export function listInstances() {
  let names;
  try {
    names = fs.readdirSync(INSTANCE_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const records = names.filter((n) => /^\d+\.json$/.test(n)).map((n) => JSON.parse(fs.readFileSync(path.join(INSTANCE_DIR, n), 'utf8')));
  if (!records.length) return [];
  const started = startTimes(records.map((s) => s.pid));
  return records.filter((s) => started.has(s.pid) && started.get(s.pid) <= s.startedAt);
}

async function post(instance, method, params, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${instance.port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json();
  if (!body.ok) throw Error(`PLUGIN_ERROR(${method}): ${body.error}`);
  return body.value;
}

// statusMs is picked: a window that does not answer its status in this long is passed over.
export const BRIDGE_TIMING = { statusMs: 5000 };
// The window each project (real path) was last found in, asked first next time. Every window is asked only
// when that one no longer shows the project, so a hung or closing window costs nothing until then.
const lastSeen = new Map();

const realPath = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

async function projectOf(instance) {
  const st = await post(instance, 'status', {}, BRIDGE_TIMING.statusMs);
  return st.projectPath ? realPath(st.projectPath) : null;
}

// Selects the plugin instance by pid, or by the project path open in that window. Windows are asked
// together, and one that does not answer (hung, closing) does not keep the others from being found.
export async function resolveInstance({ pid, projectPath } = {}) {
  const live = listInstances();
  if (pid) {
    const hit = live.find((s) => s.pid === pid);
    if (!hit) throw Error(`NO_PLUGIN_INSTANCE: pid ${pid}`);
    return hit;
  }
  if (!projectPath) {
    if (live.length === 1) return live[0];
    throw Error(`AMBIGUOUS_INSTANCE: ${live.length} plugin instances; pass project_path`);
  }
  const want = fs.realpathSync(projectPath);
  const known = live.find((s) => s.pid === lastSeen.get(want));
  if (known && (await projectOf(known).catch(() => null)) === want) return known;
  const answers = await Promise.allSettled(live.map(projectOf));
  const matches = live.filter((s, i) => answers[i].status === 'fulfilled' && answers[i].value === want);
  if (matches.length === 1) {
    lastSeen.set(want, matches[0].pid);
    return matches[0];
  }
  const silent = live.flatMap((s, i) => (answers[i].status === 'rejected' ? [`${s.pid} (${answers[i].reason.message})`] : []));
  throw Error(`NO_UNIQUE_PLUGIN_INSTANCE for ${projectPath}: ${matches.length} matches${silent.length ? `; windows that did not answer: ${silent.join(', ')}` : ''}`);
}

export async function callPlugin(method, params = {}, { pid, projectPath, timeoutMs = 120000 } = {}) {
  const instance = await resolveInstance({ pid, projectPath });
  return post(instance, method, params, timeoutMs);
}
