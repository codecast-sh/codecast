// Moments: the evidence a codecast judge reads when a product brings moments
// (docs/architecture/learning-loop.md LL3, LL7). The product posts a one-line
// event through the ingest door; codecast coalesces events per (kind,
// subject), runs the product's extractor on the product's host, and keeps the
// moment it returns. This file is the contract every side reads: the event
// item, the moment's blocks, how a moment renders for a judge, and the header
// an extractor file carries.

/** A moment kind names its extractor file (.codecast/moments/<kind>.ts), so it is a file-safe slug. */
export const MOMENT_KIND = /^[a-z][a-z0-9_-]{0,63}$/;

/** The door's item (LL7): something worth judging happened. */
export interface MomentEventItem {
  type: "moment";
  kind: string;
  /** What the moment is about, in the product's own id (a conversation, a call). Events coalesce per kind and subject. */
  subject: string;
  /** Rows in the product the event came from, by name: { thread: "t_81", message: "m_9" }. */
  refs?: Record<string, string>;
  at: number;
}

export const MOMENT_LIMITS = {
  subject_chars: 200,
  /** Blocks one moment may hold; an extractor that returns more is refused, not trimmed. */
  blocks: 400,
  body_chars: 8_000,
  label_chars: 120,
  value_chars: 2_000,
  text_chars: 20_000,
  refs: 20,
  /** The serialized moment; larger is refused so a judge prompt stays bounded. */
  json_bytes: 256 * 1024,
  /** Bodies are kept this long (the replays bucket expires every object after 30 days). */
  retention_ms: 30 * 24 * 60 * 60 * 1000,
} as const;

/** How long a kind waits after its newest event before extraction, unless its extractor says otherwise. */
export const DEFAULT_QUIET_MS = 5 * 60_000;
/** An extractor runs at most this long unless its header says otherwise. */
export const DEFAULT_EXTRACT_TIMEOUT_MS = 60_000;
export const MAX_QUIET_MS = 24 * 60 * 60_000;
export const MAX_EXTRACT_TIMEOUT_MS = 10 * 60_000;

/** One message in a conversation, as the person on either side saw it. */
export interface MomentMessage {
  type: "message";
  /** in: to the product (the customer wrote); out: from the product (the agent wrote). */
  direction: "in" | "out";
  /** sms, email, call, chat, ... in the product's words. */
  channel: string;
  at: number;
  sender?: string;
  body: string;
  /** Where the message is now: queued, sent, delivered, failed, read. A judge needs it to tell late from lost. */
  delivery?: string;
}

/** Facts the judge needs about the state of things, as label and value. */
export interface MomentFacts {
  type: "facts";
  title?: string;
  facts: Array<{ label: string; value: string }>;
}

export interface MomentText {
  type: "text";
  title?: string;
  text: string;
}

export type MomentBlock = MomentMessage | MomentFacts | MomentText;

/** A product row the moment was built from. */
export interface MomentRef {
  label: string;
  id: string;
  table?: string;
  url?: string;
}

/** What an extractor prints: the blocks, the rows they came from, and optionally the moment's own time. */
export interface ExtractorOutput {
  blocks: MomentBlock[];
  refs: MomentRef[];
  at?: number;
}

/** A moment as codecast keeps it: the extractor's output plus where and when it came from. */
export interface MomentRecord extends ExtractorOutput {
  kind: string;
  subject: string;
  /** The newest event's time. */
  event_at: number;
  extracted_at: number;
  /** extracted_at minus event_at: how stale the facts may be against what the judge reads. */
  gap_ms: number;
  extractor: { path: string; version: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined => {
  if (typeof v === "number" || typeof v === "boolean") v = String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};
const time = (v: unknown): number | undefined => {
  const ms = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
};

/** The door's check of one moment item: the item, or why it was refused. */
export function validateMomentEvent(raw: Record<string, unknown>, at: number): MomentEventItem | string {
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  if (!MOMENT_KIND.test(kind)) return "moment needs a kind: lowercase letters, digits, - and _, starting with a letter";
  const subject = text(raw.subject, MOMENT_LIMITS.subject_chars);
  if (!subject) return "moment needs a subject";
  let refs: Record<string, string> | undefined;
  if (isObject(raw.refs)) {
    refs = {};
    for (const k of Object.keys(raw.refs).slice(0, MOMENT_LIMITS.refs)) {
      const value = text(raw.refs[k], MOMENT_LIMITS.label_chars);
      if (value) refs[k.slice(0, MOMENT_LIMITS.label_chars)] = value;
    }
    if (!Object.keys(refs).length) refs = undefined;
  }
  return { type: "moment", kind, subject, ...(refs ? { refs } : {}), at };
}

function block(raw: unknown, i: number): MomentBlock | string {
  if (!isObject(raw)) return `block ${i} is not an object`;
  const L = MOMENT_LIMITS;
  switch (raw.type) {
    case "message": {
      if (raw.direction !== "in" && raw.direction !== "out") return `block ${i}: a message's direction is "in" or "out"`;
      const at = time(raw.at);
      if (!at) return `block ${i}: a message needs its time (at)`;
      const body = typeof raw.body === "string" ? raw.body.slice(0, L.body_chars) : undefined;
      if (body === undefined) return `block ${i}: a message needs a body`;
      const out: MomentMessage = { type: "message", direction: raw.direction, channel: text(raw.channel, L.label_chars) ?? "unknown", at, body };
      const sender = text(raw.sender, L.label_chars);
      const delivery = text(raw.delivery, L.label_chars);
      if (sender) out.sender = sender;
      if (delivery) out.delivery = delivery;
      return out;
    }
    case "facts": {
      if (!Array.isArray(raw.facts)) return `block ${i}: facts needs a list of { label, value }`;
      const facts: MomentFacts["facts"] = [];
      for (const f of raw.facts) {
        if (!isObject(f)) continue;
        const label = text(f.label, L.label_chars);
        const value = f.value === null ? "none" : text(f.value, L.value_chars);
        if (label && value !== undefined) facts.push({ label, value });
      }
      const title = text(raw.title, L.label_chars);
      return { type: "facts", ...(title ? { title } : {}), facts };
    }
    case "text": {
      const body = text(raw.text, L.text_chars);
      if (!body) return `block ${i}: text needs text`;
      const title = text(raw.title, L.label_chars);
      return { type: "text", ...(title ? { title } : {}), text: body };
    }
    default:
      return `block ${i}: unknown type ${JSON.stringify(raw.type)?.slice(0, 40)} (message, facts or text)`;
  }
}

/**
 * An extractor's stdout as a moment, or why it cannot be one. Refuses rather
 * than trims a moment past its caps: a judge that reads half a conversation
 * judges a different conversation.
 */
export function parseExtractorOutput(raw: unknown): ExtractorOutput | { error: string } {
  let value = raw;
  if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).length > MOMENT_LIMITS.json_bytes) return { error: `the moment is over ${MOMENT_LIMITS.json_bytes} bytes` };
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: "the extractor did not print JSON" };
    }
  }
  if (!isObject(value)) return { error: "the extractor printed no object" };
  if (!Array.isArray(value.blocks)) return { error: "the moment needs blocks: a list of message, facts and text blocks" };
  if (value.blocks.length > MOMENT_LIMITS.blocks) return { error: `the moment has ${value.blocks.length} blocks, at most ${MOMENT_LIMITS.blocks}` };
  const blocks: MomentBlock[] = [];
  for (let i = 0; i < value.blocks.length; i++) {
    const b = block(value.blocks[i], i);
    if (typeof b === "string") return { error: b };
    blocks.push(b);
  }
  const refs: MomentRef[] = [];
  for (const r of Array.isArray(value.refs) ? value.refs.slice(0, MOMENT_LIMITS.refs) : []) {
    if (!isObject(r)) continue;
    const label = text(r.label, MOMENT_LIMITS.label_chars);
    const id = text(r.id, MOMENT_LIMITS.label_chars);
    if (!label || !id) continue;
    const table = text(r.table, MOMENT_LIMITS.label_chars);
    const url = text(r.url, 2048);
    refs.push({ label, id, ...(table ? { table } : {}), ...(url && /^https?:\/\//.test(url) ? { url } : {}) });
  }
  const at = time(value.at);
  return { blocks, refs, ...(at ? { at } : {}) };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A duration in words a person reads: "4 minutes", "2 hours". */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/**
 * A moment as a judge reads it: what it is, the rows it came from, then each
 * block in order. Consecutive messages read as one conversation, each line
 * with its time, direction, channel, sender and delivery state, because a
 * judge cannot tell late from lost without them (the-line-model.md LM8).
 */
export function renderMoment(m: MomentRecord): string {
  const out: string[] = [`Moment: ${m.kind} for ${m.subject}, happened ${iso(m.at ?? m.event_at)}.`];
  if (m.refs.length) out.push(`From: ${m.refs.map((r) => `${r.label} ${r.id}`).join(", ")}`);
  let inConversation = false;
  for (const b of m.blocks) {
    if (b.type === "message") {
      if (!inConversation) out.push("", "## Conversation");
      inConversation = true;
      const who = b.direction === "in" ? `in from ${b.sender ?? "them"}` : `out from ${b.sender ?? "us"}`;
      const state = b.delivery ? ` [${b.delivery}]` : "";
      out.push(`[${iso(b.at)}] ${who}, ${b.channel}${state}:`, ...b.body.split("\n").map((l) => `  ${l}`));
      continue;
    }
    inConversation = false;
    if (b.type === "facts") {
      out.push("", `## ${b.title ?? "Facts"}`);
      for (const f of b.facts) out.push(`- ${f.label}: ${f.value}`);
    } else {
      out.push("", `## ${b.title ?? "Note"}`, b.text);
    }
  }
  return out.join("\n") + "\n";
}

/** "90s", "10m", "2h", or a bare number of seconds, as ms; null when it is none of those. */
export function parseDuration(raw: string): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  return Math.round(n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000));
}

export interface ExtractorHeader {
  quiet_ms: number;
  timeout_ms: number;
}

/**
 * An extractor's settings, read from the `//` comment lines that open its
 * file (`// quiet: 10m`, `// timeout: 90s`), so the server learns them without
 * running the file. Unknown keys and bad values are reported, not guessed.
 */
export function parseExtractorHeader(source: string): ExtractorHeader & { problems: string[] } {
  const header: ExtractorHeader & { problems: string[] } = { quiet_ms: DEFAULT_QUIET_MS, timeout_ms: DEFAULT_EXTRACT_TIMEOUT_MS, problems: [] };
  for (const line of source.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (!t.startsWith("//")) break;
    const kv = t.slice(2).trim().match(/^(quiet|timeout)\s*:\s*(.+)$/i);
    if (!kv) continue;
    const ms = parseDuration(kv[2]);
    const key = kv[1].toLowerCase() as "quiet" | "timeout";
    const max = key === "quiet" ? MAX_QUIET_MS : MAX_EXTRACT_TIMEOUT_MS;
    if (ms === null || ms <= 0 || ms > max) header.problems.push(`${key}: "${kv[2]}" is not a duration up to ${durationWords(max)}`);
    else if (key === "quiet") header.quiet_ms = ms;
    else header.timeout_ms = ms;
  }
  return header;
}

/** Where moment bodies live: on the extractor's host (the default, nothing leaves it to storage) or in codecast for 30 days. */
export const MOMENT_STORAGES = ["host", "codecast"] as const;
export type MomentStorage = (typeof MOMENT_STORAGES)[number];

export const MOMENT_STATUSES = ["waiting", "extracting", "ready", "failed"] as const;
export type MomentStatus = (typeof MOMENT_STATUSES)[number];

/** What an extractor receives on stdin: the coalesced event. */
export interface ExtractorInput {
  kind: string;
  subject: string;
  /** The newest event's time and refs. */
  at: number;
  refs: Record<string, string>;
  /** How many events this moment coalesced. */
  events: number;
  /** codecast's handle for the moment (mo-N). */
  moment: string;
}
