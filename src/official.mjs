// Client for 像塑's official MCP (streamable HTTP). Connects lazily, reconnects after the editor restarts,
// and reports when the official tool list changes so the proxy can notify its own clients.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { longFetch } from './longfetch.mjs';

export const OFFICIAL_URL = process.env.XIANGSU_MCP_URL ?? 'http://127.0.0.1:17320/mcp';
// Generation tools (images, audio, workflows) can run for minutes.
const CALL_TIMEOUT_MS = 15 * 60 * 1000;

// The call never reached an editor (none was listening), so nothing ran and it can simply be made again.
export class OfficialUnreachable extends Error {}

const refused = (e) => e?.cause?.code === 'ECONNREFUSED';
const describe = (e) => `${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ''}`;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : stableStringify(item))).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(',')}}`;
}

function fingerprint(tools) {
  return stableStringify(
    (tools ?? []).map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    })),
  );
}

async function defaultConnect(url) {
  const client = new Client({ name: 'xiangsu-mcp-plus', version: '0.3.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { fetch: longFetch }));
  return client;
}

export class OfficialMcp {
  constructor({ url = OFFICIAL_URL, connect = defaultConnect, onToolsChanged } = {}) {
    this.url = url;
    this.connectFn = connect;
    this.onToolsChanged = onToolsChanged;
    this.client = null;
    this.connecting = null;
    this.tools = [];
    this.lastError = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        try {
          const client = await this.connectFn(this.url);
          if (typeof client.setNotificationHandler === 'function') {
            client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
              this.refreshTools().catch(() => {});
            });
          }
          const { tools } = await client.listTools();
          const changed = fingerprint(tools) !== fingerprint(this.tools);
          this.client = client;
          this.tools = tools;
          this.lastError = null;
          if (changed && this.onToolsChanged) this.onToolsChanged();
          return client;
        } catch (e) {
          this.lastError = String(e?.message ?? e);
          throw e;
        } finally {
          this.connecting = null;
        }
      })();
    }
    return this.connecting;
  }

  reset() {
    const c = this.client;
    this.client = null;
    if (c) c.close().catch(() => {});
  }

  status() {
    return { url: this.url, connected: !!this.client, tools: this.tools.length, last_error: this.lastError };
  }

  async refreshTools() {
    if (!this.client) return this.tools;
    const { tools } = await this.client.listTools();
    const changed = fingerprint(tools) !== fingerprint(this.tools);
    this.tools = tools;
    if (changed && this.onToolsChanged) this.onToolsChanged();
    return this.tools;
  }

  // Cached official tools; an unreachable editor yields the last known list (empty before first contact).
  async listTools() {
    try {
      await this.connect();
    } catch (_) {}
    return this.tools;
  }

  // Protocol-level errors (bad arguments, unknown tool, timeout) are the official server's answer.
  // Nothing is sent twice: the official server answers each call with one plain JSON response when it
  // is done (no session, no stream), so a connection lost after sending may leave the call running in
  // the editor (a generation that charges the account). A transport failure only drops the client, and
  // the next call connects afresh.
  async callTool(name, args) {
    let client;
    try {
      client = await this.connect();
    } catch (e) {
      throw new OfficialUnreachable(describe(e), { cause: e });
    }
    try {
      return await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true });
    } catch (e) {
      if (e instanceof McpError) throw e;
      this.reset();
      if (refused(e)) throw new OfficialUnreachable(describe(e), { cause: e });
      throw e;
    }
  }

  async callJson(name, args) {
    const res = await this.callTool(name, args);
    const text = (res.content || []).find((c) => c.type === 'text')?.text;
    if (res.isError) throw Error(`OFFICIAL_TOOL_ERROR(${name}): ${text ?? 'unknown error'}`);
    try {
      return JSON.parse(text);
    } catch (_) {
      throw Error(`OFFICIAL_TOOL_BAD_RESPONSE(${name}): ${String(text).slice(0, 200)}`);
    }
  }

  // Keeps trying to connect while disconnected so tools appear once 像塑 starts.
  watch(intervalMs = 5000) {
    const timer = setInterval(() => {
      if (!this.client) this.connect().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    return timer;
  }
}
