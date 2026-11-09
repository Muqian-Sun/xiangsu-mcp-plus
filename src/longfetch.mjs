// fetch for calls that legitimately run for minutes (an effect check, a generation, a download).
// Node's built-in fetch fails any answer whose headers take over 300 s, or whose body pauses that long
// (undici's headersTimeout / bodyTimeout), whatever the AbortSignal allows: measured, a plugin reply
// sent after 320 s failed at 301 s with UND_ERR_HEADERS_TIMEOUT. The plugin and the official MCP both
// answer a call with a single response once it is done, so how long a call may take is left to the
// caller's own deadline (an AbortSignal, the SDK's request timeout).
import { Agent, fetch } from 'undici';

const agent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export const longFetch = (url, init = {}) => fetch(url, { ...init, dispatcher: agent });
