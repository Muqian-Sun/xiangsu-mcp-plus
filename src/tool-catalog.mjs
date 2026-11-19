// Clients verified to have native deferred tool loading (e.g. Claude Code ToolSearch), so exposing
// full typed tools directly avoids double indirection without bloating the upfront prompt.
// All other clients (Cursor, Codex, Grok Build, ZCode, Antigravity, unknown) default to compact mode
// so their tool count and upfront schema budget stay small (~32 tools, <42 KB).
const DEFAULT_FLAT_CLIENTS = [/^claude[-_ ]?code$/i];

export function isNativeDeferredClient(clientInfo, extra = process.env.XIANGSU_MCP_FLAT_CLIENTS) {
  const name = String(clientInfo?.name || '').trim();
  if (!name) return false;
  if (DEFAULT_FLAT_CLIENTS.some((re) => re.test(name))) return true;
  if (extra) {
    const list = extra.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (list.includes(name.toLowerCase())) return true;
  }
  return false;
}

// Compact-mode direct set (for clients without native deferred tool loading, enabled automatically
// in auto mode or forced via XIANGSU_MCP_COMPACT_TOOLS=1 / XIANGSU_MCP_FLAT_TOOLS=0). Sized from
// server.log (19,686 calls, plus 2,326 post-progressive-discovery calls): expands from the prior 16
// (58%) to 29 tools covering >85% of real calls plus editor_capabilities / menu_list / menu_add so
// built-in capabilities are visible.
export const DIRECT_TOOLS = new Set([
  'brief_today',
  'edit_by_dsl',
  'editor_capabilities',
  'effect_detail',
  'effect_search',
  'effect_videos',
  'ext_status',
  'get_project_context',
  'get_script_logs',
  'image_view',
  'inspect',
  'inspect_many',
  'inspiration_detail',
  'inspirations_find',
  'interact_by_dsl',
  'library_apply',
  'library_search',
  'list_resources',
  'menu_add',
  'menu_list',
  'preview_frames',
  'project_close',
  'project_open',
  'rank_list',
  'run_otsc_check',
  'save_project',
  'scene_tree',
  'set_preview_video',
  'topic_crowd',
]);

// Picked to keep each search result short enough to scan in one tool response.
const PAGE_SIZE = 12;
const SUMMARY_CHARS = 120;

// High-frequency Chinese / colloquial queries that miss the English tool names.
const SYNONYMS = [
  [/抠图|抠像/gu, 'matting image_ai_edit'],
  [/美瞳/gu, 'eye makeup'],
  [/变脸/gu, 'gan custom_gan face_warp'],
  [/报错|日志/gu, 'script_logs get_script_logs'],
  [/提审|发布|送审/gu, 'submit'],
  [/字体/gu, 'font'],
  [/打包/gu, 'bundle'],
  [/内置|能力|组件|菜单/gu, 'editor_capabilities menu_list menu_add'],
  [/排行榜|榜单|挑战榜/gu, 'rank_list rank_hotspots rank_subjects'],
  [/热榜|热点/gu, 'douyin_hot_list hot_topics rank_hotspots'],
  [/截图|截帧|预览/gu, 'preview_frames capture_preview preview_videos'],
  [/触摸|点击|滑动|交互/gu, 'interact_by_dsl preview_actions'],
  [/检测|性能|帧率/gu, 'effect_check run_otsc_check'],
  [/音效|声音|音乐/gu, 'sfx_synth music_search music_apply preview_audio_test'],
];

const normalize = (value) => value.normalize('NFKC').toLowerCase().replace(/[_\s]+/gu, ' ').trim();

function expandQuery(query) {
  let q = query;
  for (const [re, extra] of SYNONYMS) q = q.replace(re, (m) => `${m} ${extra}`);
  return normalize(q);
}

function searchableOf(tool) {
  // The keywords again with all whitespace stripped, so compound queries typed without spaces
  // (「抖音热榜」, "AI妆容") still hit spaced keywords (「抖音 热榜」, "AI 妆容").
  const kw = tool.keywords ?? '';
  return normalize([tool.name, tool.title, tool.description, kw, kw.replace(/\s+/gu, '')].join(' '));
}

function rank(tool, query, words) {
  const name = normalize(tool.name);
  if (!query || name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (words.every((word) => name.includes(word))) return 2;
  const searchable = searchableOf(tool);
  return words.every((word) => searchable.includes(word)) ? 3 : null;
}

function tokenHits(tool, words) {
  const searchable = searchableOf(tool);
  return words.reduce((n, word) => n + (searchable.includes(word) ? 1 : 0), 0);
}

// Sentences end at CJK marks, ASCII marks, or a dot followed by whitespace/end (so "9.8.3" and
// "xiangsu.muqian.chat" stay whole; descriptions avoid "e.g." so a split never lands mid-word).
function summarize(tool) {
  const firstLine = (tool.description?.trim() || tool.title || '').split(/[。！？!?]|\.(?=\s|$)|\n\r|\n/u, 1)[0];
  const chars = Array.from(firstLine);
  return chars.length > SUMMARY_CHARS ? `${chars.slice(0, SUMMARY_CHARS).join('').trimEnd()}…` : firstLine;
}

function paramSignature(tool) {
  const schema = tool.inputSchema;
  if (schema?.properties) {
    const req = new Set(Array.isArray(schema.required) ? schema.required : []);
    const keys = Object.keys(schema.properties);
    return keys.length ? keys.map((k) => (req.has(k) ? `${k}*` : k)).join(', ') : '';
  }
  if (tool.shape && typeof tool.shape === 'object') {
    const keys = Object.keys(tool.shape);
    return keys.length
      ? keys.map((k) => (typeof tool.shape[k]?.isOptional === 'function' && tool.shape[k].isOptional() ? k : `${k}*`)).join(', ')
      : '';
  }
  return '';
}

export function searchTools(tools, query = '', offset = 0) {
  const phrase = expandQuery(query);
  const words = phrase ? phrase.split(' ').filter(Boolean) : [];
  let matches = tools
    .map((tool) => ({ tool, score: rank(tool, phrase, words) }))
    .filter(({ score }) => score !== null);
  // Multi-word queries that miss every full-word hit still return something: rank by how many
  // tokens hit (score 4), instead of an empty page.
  if (!matches.length && words.length > 1) {
    matches = tools
      .map((tool) => ({ tool, score: 4, hits: tokenHits(tool, words) }))
      .filter(({ hits }) => hits > 0)
      .sort((a, b) => b.hits - a.hits || a.tool.name.localeCompare(b.tool.name, 'en'));
  } else {
    matches.sort((a, b) => a.score - b.score || a.tool.name.localeCompare(b.tool.name, 'en'));
  }
  const end = offset + PAGE_SIZE;
  return {
    total: matches.length,
    next_offset: end < matches.length ? end : null,
    tools: matches.slice(offset, end).map(({ tool }) => {
      const params = paramSignature(tool);
      return { name: tool.name, ...(params ? { params } : {}), summary: summarize(tool) };
    }),
  };
}

// Append a note when a direct tool's description names a tool that is not itself direct, so agents
// do not call the hidden name blindly.
export function withHiddenToolHints(description, { self, knownNames }) {
  const mentioned = [...knownNames]
    .filter((name) => name !== self && !DIRECT_TOOLS.has(name))
    .filter((name) => new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`).test(description))
    .sort();
  if (!mentioned.length) return description;
  return `${description} (Note: ${mentioned.join(', ')} are not in the default direct-call set; look up their parameters with tool_describe, then call them via tool_call)`;
}
