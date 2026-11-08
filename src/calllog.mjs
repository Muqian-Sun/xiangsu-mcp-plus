// One JSON line per tool call (name, duration, error) and per crash of this server, kept in the state
// directory so a failure an agent only paraphrased can be looked up afterwards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Picked: a few days of heavy use; the older half moves to server.log.1 when the file grows past it.
const MAX_BYTES = 5 * 1024 * 1024;
// Picked: long enough for any error message the tools produce, short enough to keep lines readable.
const MAX_TEXT = 500;

export class CallLog {
  constructor({ stateDir = process.env.XIANGSU_MCP_EXT_STATE || path.join(os.homedir(), '.xiangsu-mcp-ext'), now = () => new Date() } = {}) {
    this.file = path.join(stateDir, 'logs', 'server.log');
    this.now = now;
  }

  write(entry) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
      fs.appendFileSync(this.file, `${JSON.stringify({ at: this.now().toISOString(), pid: process.pid, ...entry })}\n`);
    } catch (_) {
      // Logging must never fail a tool call.
    }
  }

  call({ tool, ms, result, error, progress }) {
    const text = error ?? (result && result.isError ? result.content?.[0]?.text : undefined);
    this.write({ tool, ms, ok: text === undefined, ...(text === undefined ? {} : { error: String(text).slice(0, MAX_TEXT) }), progress });
  }
}
