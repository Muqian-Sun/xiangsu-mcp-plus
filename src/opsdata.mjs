// The operations platform (xiangsu.muqian.chat/v2, repo 运营平台) collects the account's effect list and messages
// every 10 minutes, the data cards hourly and the platform's picks, hot lists and tasks daily, and works them into
// conclusions. The agent tools (pipeline_works, account_status, changes_since, brief_today, track_board, pick_samples,
// failure_lessons, hot_topics, task_usage …) read its read-only /api/agent/* endpoints with its token; the old
// dashboard's ops_* tools were retired once the platform covered them (2026-11-14).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLATFORM_URL = process.env.XIANGSU_PLATFORM_URL || 'https://xiangsu.muqian.chat/v2';
export const PLATFORM_TOKEN_FILE = process.env.XIANGSU_PLATFORM_TOKEN_FILE || path.join(os.homedir(), '.config', 'xiangsu-ops', 'token');
// Picked: the platform answers from what it already holds, in under a second.
const TIMEOUT_MS = 30000;

export function readPlatformToken(file = PLATFORM_TOKEN_FILE) {
  let token = '';
  try {
    token = fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!token) throw Error(`OPS_TOKEN_MISSING: no read-only token in ${file} (the platform's agent token, written by 运营平台/deploy/set-secrets.sh); set XIANGSU_PLATFORM_TOKEN_FILE or put the token there`);
  return token;
}

// The platform lives under a path (/v2): join it by hand, new URL('/api/…', base) would drop the /v2.
export async function platformRequest(pathname, { method = 'GET', body, baseUrl = PLATFORM_URL, token = readPlatformToken(), fetchImpl = fetch } = {}) {
  const init = { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) Object.assign(init, { body: JSON.stringify(body), headers: { ...init.headers, 'content-type': 'application/json' } });
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${pathname}`, init);
  const out = await res.json().catch(() => null);
  if (!res.ok) throw Error(`OPS_HTTP_${res.status}: ${out?.error ?? res.statusText} (${method} ${pathname})`);
  return out;
}
