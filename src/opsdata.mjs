// Two read-only sources of the account's operations data, both off the editor:
// - The new operations platform (xiangsu.muqian.chat/v2, repo 运营平台) collects the effect list and messages
//   every 10 minutes and the data cards hourly; pipeline_works, pipeline_work, account_status, changes_since,
//   changes_ack and pipeline_refresh read its /api/agent/* endpoints with its read-only token.
// - The old dashboard (xiangsu.muqian.chat) still backs ops_tracks, ops_market, ops_feedback and ops_refresh
//   until the platform's later phases replace them; ops_works, ops_work and ops_account were retired
//   (2026-11-14) in favour of the platform's tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OPS_URL = process.env.XIANGSU_OPS_URL || 'https://xiangsu.muqian.chat';
export const OPS_TOKEN_FILE = process.env.XIANGSU_OPS_TOKEN_FILE || path.join(os.homedir(), '.config', 'xiangsu-dashboard', 'feedback-token');
export const PLATFORM_URL = process.env.XIANGSU_PLATFORM_URL || 'https://xiangsu.muqian.chat/v2';
export const PLATFORM_TOKEN_FILE = process.env.XIANGSU_PLATFORM_TOKEN_FILE || path.join(os.homedir(), '.config', 'xiangsu-ops', 'token');
// Picked: both answer from what they already hold, in under a second.
const OPS_TIMEOUT_MS = 30000;

function readToken(file, what, envName) {
  let token = '';
  try {
    token = fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!token) throw Error(`OPS_TOKEN_MISSING: no read-only token in ${file} (${what}); set ${envName} or put the token there`);
  return token;
}

export const readOpsToken = (file = OPS_TOKEN_FILE) => readToken(file, "the dashboard's FEEDBACK_TOKEN", 'XIANGSU_OPS_TOKEN_FILE');
export const readPlatformToken = (file = PLATFORM_TOKEN_FILE) => readToken(file, "the platform's agent token, written by 运营平台/deploy/set-secrets.sh", 'XIANGSU_PLATFORM_TOKEN_FILE');

async function send(url, label, { method, token, body, fetchImpl }) {
  const init = { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(OPS_TIMEOUT_MS) };
  if (body !== undefined) Object.assign(init, { body: JSON.stringify(body), headers: { ...init.headers, 'content-type': 'application/json' } });
  const res = await fetchImpl(url, init);
  const out = await res.json().catch(() => null);
  if (!res.ok) throw Error(`OPS_HTTP_${res.status}: ${out?.error ?? res.statusText} (${method} ${label})`);
  return out;
}

export function opsRequest(pathname, { method = 'GET', baseUrl = OPS_URL, token = readOpsToken(), fetchImpl = fetch } = {}) {
  return send(new URL(pathname, baseUrl), pathname, { method, token, fetchImpl });
}

// The platform lives under a path (/v2): join it by hand, new URL('/api/…', base) would drop the /v2.
export function platformRequest(pathname, { method = 'GET', body, baseUrl = PLATFORM_URL, token = readPlatformToken(), fetchImpl = fetch } = {}) {
  return send(`${baseUrl.replace(/\/$/, '')}${pathname}`, pathname, { method, token, body, fetchImpl });
}
