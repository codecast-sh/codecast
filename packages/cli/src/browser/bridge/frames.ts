/**
 * The relay's hot path, read and written as bytes.
 *
 * Nearly every byte through the host is one of two extension messages: a tab
 * event, or the reply to a `cdp` request. Both carry their payload LAST, in a
 * shape fixed by background.js (send() is JSON.stringify of an object literal):
 *
 *   {"op":"event","tabId":7,"method":"Network.dataReceived","params":{…}}
 *   {"id":12,"ok":true,"result":{…}}
 *
 * so the routing fields sit in the first bytes and the payload runs to the
 * closing brace. The host reads the routing fields there and passes the
 * payload through untouched. Decoding it instead (Buffer to string, a parse,
 * then a stringify per client) is what saturated the host: an agent tab on a
 * busy page streams megabytes a second of events (websocket frames, console
 * stacks, DOM mutations), and on a loaded machine the host's one thread could
 * not keep up, so it stopped answering its health probe and every verb failed.
 *
 * A message in any other shape returns null and takes the parsed path, so an
 * extension that changes its key order costs speed, never correctness.
 */

const EVENT_HEAD = Buffer.from('{"op":"event","tabId":', "latin1");
const EVENT_METHOD = Buffer.from(',"method":"', "latin1");
const EVENT_PARAMS = Buffer.from(',"params":', "latin1");
const REPLY_HEAD = Buffer.from('{"id":', "latin1");
const REPLY_OK = Buffer.from(',"ok":true,"result":', "latin1");
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const CLOSE_BRACE = 0x7d;

/** True when `buf` holds `part` at `at`. */
function holds(buf: Buffer, part: Buffer, at: number): boolean {
  return at + part.length <= buf.length && buf.compare(part, 0, part.length, at, at + part.length) === 0;
}

/** The decimal integer at `at`, and where it ends; null when there is none. */
function readUint(buf: Buffer, at: number): { value: number; end: number } | null {
  let i = at;
  let value = 0;
  while (i < buf.length && i - at < 15 && buf[i] >= 0x30 && buf[i] <= 0x39) value = value * 10 + (buf[i++] - 0x30);
  return i === at ? null : { value, end: i };
}

export interface EventFrame {
  tabId: number;
  method: string;
  /** The event's params, still JSON bytes. */
  params: Buffer;
}

/** A tab event, routed from its first bytes; null for any other message. */
export function readEventFrame(buf: Buffer): EventFrame | null {
  if (buf[buf.length - 1] !== CLOSE_BRACE || !holds(buf, EVENT_HEAD, 0)) return null;
  const tab = readUint(buf, EVENT_HEAD.length);
  if (!tab || !holds(buf, EVENT_METHOD, tab.end)) return null;
  const start = tab.end + EVENT_METHOD.length;
  let i = start;
  // CDP method names are plain identifiers; an escape means some other shape.
  while (i < buf.length && buf[i] !== QUOTE && buf[i] !== BACKSLASH) i++;
  if (buf[i] !== QUOTE || i === start || !holds(buf, EVENT_PARAMS, i + 1)) return null;
  return { tabId: tab.value, method: buf.toString("latin1", start, i), params: buf.subarray(i + 1 + EVENT_PARAMS.length, buf.length - 1) };
}

/** A successful reply's id and its `result` as JSON bytes; null for anything else (errors included). */
export function readReplyFrame(buf: Buffer): { id: number; result: Buffer } | null {
  if (buf[buf.length - 1] !== CLOSE_BRACE || !holds(buf, REPLY_HEAD, 0)) return null;
  const id = readUint(buf, REPLY_HEAD.length);
  if (!id || !holds(buf, REPLY_OK, id.end)) return null;
  return { id: id.value, result: buf.subarray(id.end + REPLY_OK.length, buf.length - 1) };
}

/** The id of an extension reply without decoding it, so a pending request can choose the byte path. */
export function replyId(buf: Buffer): number | null {
  return holds(buf, REPLY_HEAD, 0) ? (readUint(buf, REPLY_HEAD.length)?.value ?? null) : null;
}

/** A CDP event for one client session, its params spliced in as bytes. */
export function eventMessage(method: string, params: Buffer, sessionId: string): Buffer {
  return Buffer.concat([
    Buffer.from(`{"method":${JSON.stringify(method)},"params":`),
    params,
    Buffer.from(`,"sessionId":${JSON.stringify(sessionId)}}`),
  ]);
}

/** A CDP reply, its result spliced in as bytes. */
export function replyMessage(id: number, result: Buffer, sessionId?: string): Buffer {
  const session = sessionId ? `,"sessionId":${JSON.stringify(sessionId)}` : "";
  return Buffer.concat([Buffer.from(`{"id":${id}${session},"result":`), result, Buffer.from("}")]);
}

/** A result that is already JSON bytes: sent as it is, never parsed by the host. */
export class RawJson {
  constructor(readonly bytes: Buffer) {}
}

const MB = 1024 * 1024;

/**
 * What crossed the relay, by method and by receiving session, over a window.
 * A window heavy enough to load the host is reported as one line, so the host
 * log names the tab traffic behind a slow host instead of leaving it to be
 * reconstructed from a sampled stack. Flushed on traffic, so an idle host
 * keeps no timer.
 */
export class TrafficMeter {
  private byKey = new Map<string, { n: number; bytes: number }>();
  private bySession = new Map<string, number>();
  private total = 0;
  private since: number;

  constructor(
    private readonly report: ((line: string) => void) | undefined,
    private readonly windowMs = 60_000,
    private readonly heavyBytes = 32 * MB,
    private readonly now: () => number = Date.now,
  ) {
    this.since = now();
  }

  /** Bytes the extension sent, under the event method or the request it answers. */
  note(key: string, bytes: number): void {
    const row = this.byKey.get(key) ?? { n: 0, bytes: 0 };
    row.n++;
    row.bytes += bytes;
    this.byKey.set(key, row);
    this.total += bytes;
    this.flushIfDue();
  }

  /** Bytes relayed to one client; `null` is a socket with no cast session. */
  sent(session: string | null, bytes: number): void {
    const key = session ?? "(no session)";
    this.bySession.set(key, (this.bySession.get(key) ?? 0) + bytes);
  }

  private flushIfDue(): void {
    const at = this.now();
    if (at - this.since < this.windowMs) return;
    if (this.report && this.total >= this.heavyBytes) {
      const mb = (b: number) => `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`;
      const top = [...this.byKey].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 5);
      const to = [...this.bySession].sort((a, b) => b[1] - a[1]).slice(0, 4);
      this.report(
        `heavy relay traffic: ${mb(this.total)} from the extension in ${Math.round((at - this.since) / 1000)}s — ` +
          top.map(([k, v]) => `${k} ${mb(v.bytes)} x${v.n}`).join(", ") +
          (to.length ? `; to ${to.map(([k, v]) => `${k} ${mb(v)}`).join(", ")}` : ""),
      );
    }
    this.byKey.clear();
    this.bySession.clear();
    this.total = 0;
    this.since = at;
  }
}
