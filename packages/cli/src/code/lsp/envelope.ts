// What the relay needs from a JSON-RPC message (method, id, document uri), and
// a way to give it another id. Every message is read from its ends, never
// parsed whole: completion lists run to megabytes and arrive on most
// keystrokes, so a parse per message would put the daemon's loop on the typing
// path. Callers ask for the whole message (full()) only where they need its
// body: an initialize, or a didOpen whose uri the head did not show.
//
// Every client and server we relay writes `jsonrpc`, `id`, `method` near the
// start (vscode-jsonrpc, lsp-client, serde), except Go's jsonrpc2 (gopls),
// which writes a response's id last. Both shapes are read from the ends. A
// small message that mentions an id or method the ends did not show is parsed
// to find it; a big one in some other key order reads as having none and is
// relayed untouched.

export type Id = number | string;

export interface Message {
  jsonrpc?: string;
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown> & { textDocument?: { uri?: string } };
  result?: unknown;
  error?: unknown;
}

export interface Envelope {
  text: string;
  method?: string;
  id?: Id;
  uri?: string;
  /** The whole message, parsed now if it was only peeked at. */
  full(): Message | null;
  /** The text with `id` in place of its own. */
  withId(id: Id): string;
}

/** Above this, a message the ends cannot read is relayed rather than parsed. */
export const INSPECT_MAX_CHARS = 64 * 1024;

const STR = String.raw`"(?:[^"\\]|\\.)*"`;
const ID = String.raw`-?\d+|${STR}`;
const VERSION = String.raw`"jsonrpc"\s*:\s*"2\.0"\s*,\s*`;
const HEAD_ID = new RegExp(String.raw`^\s*\{\s*(?:${VERSION})?"id"\s*:\s*(${ID})\s*,`);
const TAIL_ID = new RegExp(String.raw`,\s*"id"\s*:\s*(${ID})\s*\}\s*$`);
const HEAD_METHOD = new RegExp(String.raw`^\s*\{\s*(?:${VERSION})?(?:"id"\s*:\s*(?:${ID})\s*,\s*)?(?:${VERSION})?"method"\s*:\s*(${STR})`);
const HEAD_URI = new RegExp(String.raw`"params"\s*:\s*\{\s*"textDocument"\s*:\s*\{\s*"uri"\s*:\s*(${STR})`);
const HEAD_CHARS = 1024;
const TAIL_CHARS = 256;

export const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const parseObject = (text: string): Message | null => {
  try {
    const v: unknown = JSON.parse(text);
    return isPlainObject(v) ? (v as Message) : null;
  } catch {
    return null;
  }
};

/** Null when the text is not a JSON object (judged by its braces when big). */
export function readEnvelope(text: string): Envelope | null {
  if (!/^\s*\{/.test(text) || !/\}\s*$/.test(text.slice(-TAIL_CHARS))) return null;
  const env = peekEnvelope(text);
  if (text.length > INSPECT_MAX_CHARS) return env;
  const unsure = (env.id === undefined && text.includes('"id"')) || (env.method === undefined && text.includes('"method"'));
  if (!unsure) return env;
  const msg = env.full();
  if (!msg) return null;
  const id = typeof msg.id === "number" || typeof msg.id === "string" ? msg.id : undefined;
  return {
    ...env,
    method: typeof msg.method === "string" ? msg.method : undefined,
    id,
    uri: env.uri ?? (typeof msg.params?.textDocument?.uri === "string" ? msg.params.textDocument.uri : undefined),
    // The ends located the id when they read the same one; otherwise rewrite it.
    withId: env.id !== undefined && env.id === id ? env.withId : (newId) => JSON.stringify({ ...msg, id: newId }),
  };
}

/** Read a message from its ends. Exported for tests. */
export function peekEnvelope(text: string): Envelope {
  const head = text.slice(0, HEAD_CHARS);
  const tailStart = Math.max(0, text.length - TAIL_CHARS);
  let idAt: [number, number] | null = null;
  let idText: string | null = null;
  const fromHead = HEAD_ID.exec(head);
  if (fromHead) {
    idText = fromHead[1];
    const start = fromHead.index + fromHead[0].lastIndexOf(idText);
    idAt = [start, start + idText.length];
  } else {
    const fromTail = TAIL_ID.exec(text.slice(tailStart));
    if (fromTail) {
      idText = fromTail[1];
      const start = tailStart + fromTail.index + fromTail[0].lastIndexOf(idText);
      idAt = [start, start + idText.length];
    }
  }
  const method = HEAD_METHOD.exec(head)?.[1];
  const uri = HEAD_URI.exec(head)?.[1];
  let parsed: Message | null | undefined;
  return {
    text,
    method: method ? (JSON.parse(method) as string) : undefined,
    id: idText ? (JSON.parse(idText) as Id) : undefined,
    uri: uri ? (JSON.parse(uri) as string) : undefined,
    full: () => (parsed === undefined ? (parsed = parseObject(text)) : parsed),
    withId: (id) => (idAt ? text.slice(0, idAt[0]) + JSON.stringify(id) + text.slice(idAt[1]) : text),
  };
}
