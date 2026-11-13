// The operations dashboard (xiangsu.muqian.chat) collects the account's effects, messages, 精选 state,
// revenue and the platform's boards every hour and works them into conclusions. The tools that read the
// same account data from the editor were retired (2026-11-13, they overlapped the dashboard); the ops_*
// tools read the dashboard's read-only /api/agent/* endpoints with its read-only token instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OPS_URL = process.env.XIANGSU_OPS_URL || 'https://xiangsu.muqian.chat';
export const OPS_TOKEN_FILE = process.env.XIANGSU_OPS_TOKEN_FILE || path.join(os.homedir(), '.config', 'xiangsu-dashboard', 'feedback-token');
// Picked: the dashboard answers from its cache in under a second; the first analysis after a restart
// takes a few seconds more.
const OPS_TIMEOUT_MS = 30000;

export function readOpsToken(file = OPS_TOKEN_FILE) {
  let token = '';
  try {
    token = fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!token) throw Error(`OPS_TOKEN_MISSING: no read-only token in ${file} (the dashboard's FEEDBACK_TOKEN); set XIANGSU_OPS_TOKEN_FILE or put the token there`);
  return token;
}

export async function opsRequest(pathname, { method = 'GET', baseUrl = OPS_URL, token = readOpsToken(), fetchImpl = fetch } = {}) {
  const res = await fetchImpl(new URL(pathname, baseUrl), { method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(OPS_TIMEOUT_MS) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Error(`OPS_HTTP_${res.status}: ${body?.error ?? res.statusText} (${method} ${pathname})`);
  return body;
}
