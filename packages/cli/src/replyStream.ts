// Live replies, the daemon's half: Claude Code's MessageDisplay hook -> the
// text of the reply so far -> replyStreams:push. The contract, and why the web
// hands the stream off to the real message by itself, is in
// @codecast/shared/contracts/replyStream.
//
// The hook rides a `--settings <file>` this module writes, added per launch to
// the Claude sessions the daemon starts or resumes in tmux, so nothing is
// installed into ~/.claude. Measured on Claude Code 2.1.332, interactive, tmux:
//
//   - One batch per completed source line, at least ~100 ms apart, up to three
//     in flight. The last paragraph arrives only in the `final: true` batch.
//   - Joining one message's deltas in `index` order reproduces its transcript
//     text block byte for byte. Text before and after a tool call are two
//     message ids. The id is the hook's own and joins nothing in the transcript.
//   - Escape mid-stream sends no final batch. A stream the API aborts and
//     retries can get its final batch hours later, after the retry finished
//     under a new id, and that text never reaches the transcript. So `final`
//     does not mean the text was kept, and an old id never displaces a new one.
//   - No batches for subagents, for replies redrawn on --resume, or /compact.
//   - The person's terminal holds each batch until the hook answers, so the
//     route answers at once and everything here runs after it.
//   - A missing --settings file stops `claude` from starting, and an invalid
//     one parks it on a dialog, so the file is checked before every launch.
//
// No child_process and no synchronous fs in this module: it runs on the
// daemon's loop, behind a request a terminal is waiting on.

import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { REPLY_STREAM_MAX_CHARS, type ReplyStreamPushResult } from "@codecast/shared/contracts";

export const REPLY_STREAM_HOOK_PATH = "/hook/message-display";
export const REPLY_STREAM_SETTINGS_FILE = "reply-stream-settings.json";

/** Least time between the starts of two pushes to one conversation. */
const PUSH_SPACING_MS = 300;
/** No pushes to a conversation nobody has open for this long. */
const UNWATCHED_PAUSE_MS = 3_000;
/** No pushes to a conversation whose workspace has the feature off for this long. */
const OFF_PAUSE_MS = 10 * 60_000;
/** A conversation with no batch for this long is forgotten. Longer than the
 *  off pause, so an "off" answer is remembered for as long as it applies. */
const IDLE_FORGET_MS = 15 * 60_000;
/** Conversations tracked at once; the one with the oldest batch goes first. */
const MAX_CONVERSATIONS = 64;
/** Message ids a conversation has moved past, kept to drop their late batches. */
const MAX_PAST_IDS = 16;

export interface MessageDisplayBatch {
  session_id: string;
  message_id: string;
  index: number;
  final: boolean;
  delta: string;
}

/** One MessageDisplay hook input, or null for anything else. */
export function parseMessageDisplay(body: string): MessageDisplayBatch | null {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.hook_event_name !== "MessageDisplay") return null;
  const { session_id, message_id, index, final, delta } = o;
  if (typeof session_id !== "string" || !session_id) return null;
  if (typeof message_id !== "string" || !message_id) return null;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return null;
  if (typeof final !== "boolean" || typeof delta !== "string") return null;
  return { session_id, message_id, index, final, delta };
}

/** The settings file's content, or null when the port or token cannot be
 *  written into it as is. Claude Code reads a `$` in a header value as an env
 *  reference; the hook token is hex (hookIdentity.ts), so this refuses only a
 *  token something else wrote. */
export function replyStreamSettingsJson(port: number, token: string): string | null {
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !/^[A-Za-z0-9]+$/.test(token)) return null;
  return JSON.stringify({
    hooks: {
      MessageDisplay: [{
        hooks: [{
          type: "http",
          url: `http://127.0.0.1:${port}${REPLY_STREAM_HOOK_PATH}`,
          timeout: 1,
          headers: { Authorization: `Bearer ${token}` },
        }],
      }],
    },
  });
}

/** `<configDir>/reply-stream-settings.json`, made to hold exactly the settings
 *  for this port and token at 0600, or null when it cannot be. Called right
 *  before each launch that names it: a missing file stops the launch. */
export async function ensureReplyStreamSettings(configDir: string, port: number, token: string): Promise<string | null> {
  const content = replyStreamSettingsJson(port, token);
  if (!content) return null;
  const file = path.join(configDir, REPLY_STREAM_SETTINGS_FILE);
  try {
    const [current, st] = await Promise.all([fsp.readFile(file, "utf-8"), fsp.stat(file)]);
    if (current === content && (st.mode & 0o777) === 0o600) return file;
  } catch {}
  // Renamed into place, so a launch reading it never sees half a file.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tmp, content, { mode: 0o600 });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, file);
    return file;
  } catch {
    await fsp.unlink(tmp).catch(() => {});
    return null;
  }
}

let warnedUserSettings = false;

/** What a claude launch line gains: ` --settings <file>`, or "". A
 *  `--settings` in the person's own claude args wins, since a second one would
 *  replace theirs. */
export function replyStreamLaunchFragment(a: {
  on: boolean;
  agentType: string;
  configuredArgs: string;
  settingsPath: string | null;
  escape: (value: string) => string;
  log: (msg: string) => void;
}): string {
  if (!a.on || a.agentType !== "claude" || !a.settingsPath) return "";
  if (/(^|\s)--settings(\s|=|$)/.test(a.configuredArgs)) {
    if (!warnedUserSettings) {
      warnedUserSettings = true;
      a.log("[REPLY-STREAM] claude args carry their own --settings; sessions launch without live replies");
    }
    return "";
  }
  return ` --settings ${a.escape(a.settingsPath)}`;
}

export interface ReplyStreamPushArgs {
  message_id: string;
  seq: number;
  started_at: number;
  text: string;
}

export interface ReplyStreamTrackerDeps {
  now: () => number;
  on: () => boolean;
  conversationFor: (sessionId: string) => string | undefined;
  /** The redaction transcript text goes through before it syncs, so the stream
   *  and the message it hands off to start with the same characters. */
  redact: (text: string) => string;
  push: (conversationId: string, args: ReplyStreamPushArgs) => Promise<ReplyStreamPushResult | null>;
  log: (msg: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Message {
  id: string;
  parts: Map<number, string>;
  /** Receipt of the message's first batch. */
  startedAt: number;
  seq: number;
  sawFinal: boolean;
  /** Index 0 came with `final`: the whole message in one batch. */
  single: boolean;
  /** What the last written push carried; "" when it was not written. */
  sent: string;
}

interface Conversation {
  message: Message | null;
  past: string[];
  lastBatchAt: number;
  inFlight: boolean;
  lastPushAt: number;
  pausedUntil: number;
  timer: unknown;
}

function joined(m: Message): string {
  let out = "";
  for (let i = 0; m.parts.has(i); i++) out += m.parts.get(i);
  return out;
}

/**
 * The reply being written in each conversation, pushed as it grows.
 *
 * State is per conversation, since the server keeps one row per conversation:
 * one current message, and the ids it moved past. Pushes to one conversation
 * go one at a time, at least PUSH_SPACING_MS apart, except that a message's
 * final text goes as soon as the push ahead of it returns.
 */
export class ReplyStreamTracker {
  private readonly conversations = new Map<string, Conversation>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: ReplyStreamTrackerDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** How many conversations are tracked (tests). */
  get size(): number {
    return this.conversations.size;
  }

  receive(batch: MessageDisplayBatch): void {
    if (!this.deps.on()) return;
    const conversationId = this.deps.conversationFor(batch.session_id);
    if (!conversationId) return;
    const now = this.deps.now();
    this.forgetIdle(now);
    const c = this.touch(conversationId, now);
    // A late batch of a message this conversation moved past: the final of an
    // abandoned stream, whose text never reaches the transcript.
    if (c.past.includes(batch.message_id)) return;
    if (c.message?.id !== batch.message_id) {
      if (c.message) {
        c.past.push(c.message.id);
        if (c.past.length > MAX_PAST_IDS) c.past.shift();
      }
      c.message = { id: batch.message_id, parts: new Map(), startedAt: now, seq: 0, sawFinal: false, single: false, sent: "" };
    }
    const m = c.message;
    m.parts.set(batch.index, batch.delta);
    if (batch.final) {
      m.sawFinal = true;
      if (batch.index === 0) m.single = true;
    }
    this.pump(conversationId);
  }

  /** The conversation's state, created or moved to the newest end. */
  private touch(conversationId: string, now: number): Conversation {
    let c = this.conversations.get(conversationId);
    if (c) {
      this.conversations.delete(conversationId);
    } else {
      c = { message: null, past: [], lastBatchAt: now, inFlight: false, lastPushAt: -Infinity, pausedUntil: 0, timer: undefined };
      if (this.conversations.size >= MAX_CONVERSATIONS) {
        const [oldest] = this.conversations.keys();
        if (oldest !== undefined) this.forget(oldest);
      }
    }
    c.lastBatchAt = now;
    this.conversations.set(conversationId, c);
    return c;
  }

  /** Map order is batch order (touch), so the idle ones are at the front. */
  private forgetIdle(now: number): void {
    for (const [id, c] of this.conversations) {
      if (now - c.lastBatchAt <= IDLE_FORGET_MS) break;
      this.forget(id);
    }
  }

  private forget(conversationId: string): void {
    const c = this.conversations.get(conversationId);
    if (c?.timer !== undefined) this.clearTimer(c.timer);
    this.conversations.delete(conversationId);
  }

  private pump(conversationId: string): void {
    const c = this.conversations.get(conversationId);
    const m = c?.message;
    if (!c || !m || c.inFlight || m.single) return;
    const now = this.deps.now();
    // Paused: the first batch after the pause sends the whole text so far.
    if (now < c.pausedUntil) return;
    const wait = m.sawFinal ? 0 : c.lastPushAt + PUSH_SPACING_MS - now;
    if (wait > 0) {
      if (c.timer === undefined) {
        c.timer = this.setTimer(() => {
          c.timer = undefined;
          if (this.conversations.get(conversationId) === c) this.pump(conversationId);
        }, wait);
      }
      return;
    }
    const text = this.deps.redact(joined(m)).slice(0, REPLY_STREAM_MAX_CHARS);
    if (!text || text === m.sent) return;
    if (c.timer !== undefined) {
      this.clearTimer(c.timer);
      c.timer = undefined;
    }
    c.inFlight = true;
    c.lastPushAt = now;
    m.seq += 1;
    m.sent = text;
    let call: Promise<ReplyStreamPushResult | null>;
    try {
      call = this.deps.push(conversationId, { message_id: m.id, seq: m.seq, started_at: m.startedAt, text });
    } catch (err) {
      call = Promise.reject(err);
    }
    void call
      .then(
        (r) => r?.state ?? null,
        (err: unknown) => {
          this.deps.log(`[REPLY-STREAM] push for ${conversationId.slice(0, 12)} failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        },
      )
      .then((state) => {
        c.inFlight = false;
        if (state !== "written") {
          // Not written, so the next push sends this text again.
          if (m.sent === text) m.sent = "";
          c.pausedUntil = this.deps.now() + (state === "off" ? OFF_PAUSE_MS : UNWATCHED_PAUSE_MS);
          if (state === "off") this.deps.log(`[REPLY-STREAM] live replies are off for ${conversationId.slice(0, 12)}'s workspace; pausing 10 min`);
        }
        if (this.conversations.get(conversationId) === c) this.pump(conversationId);
      });
  }
}
