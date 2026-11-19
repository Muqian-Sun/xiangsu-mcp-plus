// Default tools/list keeps a short direct set; everything else is reached via tool_search →
// tool_describe → tool_call. DIRECT_TOOLS is sized from local call logs (16,474 calls after
 // dropping retired tools): the prior 11 covered 50%, these 16 cover 58% of (session, tool) uses.
export const DIRECT_TOOLS = new Set([
  'brief_today',
  'edit_by_dsl',
  'effect_search',
  'ext_status',
  'get_project_context',
  'image_view',
  'inspect_many',
  'inspiration_detail',
  'library_apply',
  'library_search',
  'list_resources',
  'preview_frames',
  'project_close',
  'project_open',
  'save_project',
  'scene_tree',
]);

// Picked to keep each search result short enough to scan in one tool response.
const PAGE_SIZE = 12;
const SUMMARY_CHARS = 120;

// High-frequency Chinese / colloquial queries that miss the English tool names.
const SYNONYMS = [
  [/抠图|抠像/gu, 'matting'],
  [/美瞳/gu, 'eye'],
  [/变脸/gu, 'gan face_warp'],
  [/报错|日志/gu, 'script_logs'],
  [/提审|发布/gu, 'submit'],
  [/字体/gu, 'font'],
  [/打包/gu, 'bundle'],
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
    tools: matches.slice(offset, end).map(({ tool }) => ({ name: tool.name, summary: summarize(tool) })),
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
