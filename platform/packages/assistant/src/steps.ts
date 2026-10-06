// Tool steps in plain words: each call the assistant made, said as one
// line a person who has never used a developer tool can read
// ("Read 12 emails from the past week", "Drafted a reply to Dana"), and the
// rule for how many of a run of steps show before the rest fold away. A tool
// can always say it best itself through `summary`; otherwise the name is
// matched against a small vocabulary (mail, calendar, web, to-dos, notes,
// routines), so a new tool with a familiar name reads well before anyone
// writes it a sentence. Pure: its one import is the engine's own leaf
// (@platform/agent/outcome), so web and phone bundles load it alone.

import { toolResultOutcome } from "@platform/agent/outcome";

export interface ToolCallLike {
  id?: string;
  name?: string;
  /** The call's arguments, as an object or as the JSON text a row stores. */
  input?: unknown;
  /** A plain past-tense sentence the tool or the engine wrote for people. */
  summary?: string;
}

export interface ToolResultLike {
  tool_use_id?: string;
  /** The result, as a value or as the JSON text a row stores. */
  content?: unknown;
  is_error?: boolean;
  summary?: string;
}

/** A value, or the object a row's JSON text holds; anything else is empty. */
function parsedObject(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function parsedInput(input: unknown): Record<string, any> {
  const v = parsedObject(input);
  return v && typeof v === "object" ? (v as Record<string, any>) : {};
}

/** A person's name from an address: "Dana Ruiz <dana@x.org>" is Dana Ruiz,
 *  "dana.ruiz@x.org" is Dana. */
export function personName(raw: unknown): string | null {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string" || !first.trim()) return null;
  const s = first.trim();
  const named = s.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  let name = named ? named[1].trim() : s;
  if (name.includes("@")) {
    const local = name.split("@")[0].split(/[._+-]/)[0];
    name = local ? local[0].toUpperCase() + local.slice(1) : name;
  }
  const more = Array.isArray(raw) && raw.length > 1 ? ` and ${raw.length - 1} other${raw.length > 2 ? "s" : ""}` : "";
  return name + more;
}

function quoted(s: unknown, max = 48): string | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const t = s.trim().replace(/\s+/g, " ");
  return `"${t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t}"`;
}

function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** How many items a result lists, when it says so plainly. */
function resultCount(raw: unknown): number | null {
  const content = parsedObject(raw);
  if (Array.isArray(content)) return content.length;
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    for (const k of ["count", "total", "results"]) {
      if (typeof o[k] === "number") return o[k] as number;
      if (Array.isArray(o[k])) return (o[k] as unknown[]).length;
    }
  }
  return null;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

const SPAN_WORDS: Record<string, [string, string]> = { d: ["day", "days"], w: ["week", "weeks"], m: ["month", "months"], y: ["year", "years"] };

/** A mail search in plain words. The query is Gmail's search syntax, which
 *  means nothing to this reader: "from:dana is:unread newer_than:7d" reads as
 *  unread emails " from Dana from the past week". Plain words stay as what was
 *  searched for; operators with no plain reading are left out. */
export function mailSearch(raw: unknown): { unread: boolean; scope: string } {
  if (typeof raw !== "string" || !raw.trim()) return { unread: false, scope: "" };
  const from: string[] = [];
  const about: string[] = [];
  const words: string[] = [];
  let unread = false;
  let since = "";
  for (const tok of raw.match(/-?[a-z_]+:"[^"]*"|"[^"]*"|\S+/gi) ?? []) {
    const op = tok.match(/^(-?)([a-z_]+):(.*)$/i);
    if (!op) {
      if (!/^(OR|AND)$/.test(tok)) words.push(tok.replace(/"/g, ""));
      continue;
    }
    if (op[1]) continue;
    const key = op[2].toLowerCase();
    const value = op[3].replace(/^"|"$/g, "").replace(/^[({]|[)}]$/g, "");
    if (!value) continue;
    if (key === "from") {
      const name = personName(value) ?? value;
      from.push(/[A-Z]/.test(name) ? name : name.replace(/\b\w/g, (c) => c.toUpperCase()));
    } else if (key === "subject") about.push(value);
    else if (key === "is" && value.toLowerCase() === "unread") unread = true;
    else if (key === "newer_than") {
      const span = value.match(/^(\d+)([dwmy])$/i);
      if (span) {
        const n = Number(span[1]);
        const [one, many] = SPAN_WORDS[span[2].toLowerCase()];
        since = n === 1 ? ` from the past ${one}` : n === 7 && one === "day" ? " from the past week" : ` from the past ${n} ${many}`;
      }
    }
  }
  const q = quoted(words.join(" "));
  const subject = quoted(about.join(" "));
  const scope = `${from.length ? ` from ${from.join(" or ")}` : ""}${subject ? ` about ${subject}` : ""}${q ? ` matching ${q}` : ""}${since}`;
  return { unread, scope };
}

/** A step in two forms: what was done ("Sent an email to Dana") and what
 *  doing it is ("send an email to Dana"), for a step that has not happened. */
type Words = [did: string, todo: string];
type Phrase = (input: Record<string, any>, result: ToolResultLike | undefined) => Words;

// The assistant's tools by what they do. A name matches the first rule whose
// pattern it fits.
const PHRASES: Array<[RegExp, Phrase]> = [
  [/^suggest_reply$|(suggest|write).*reply/i, () => ["Wrote a reply in your voice", "write a reply in your voice"]],
  [/summar(y|ize).*(thread|mail|email)/i, () => ["Summed up an email", "sum up an email"]],
  [/(send|reply).*(mail|email|message)|^send_?(mail|email)$/i, (i) => {
    const to = personName(i.to ?? i.recipient ?? i.recipients);
    const what = to ? `an email to ${to}` : "an email";
    return [`Sent ${what}`, `send ${what}`];
  }],
  [/draft/i, (i) => {
    const to = personName(i.to ?? i.recipient ?? i.recipients);
    const what = to ? `a reply to ${to}` : "a reply";
    return [`Drafted ${what}`, `draft ${what}`];
  }],
  [/(search|list|read|get|find|check).*(mail|email|inbox|thread)/i, (i, r) => {
    const n = resultCount(r?.content);
    const { unread, scope } = mailSearch(i.query ?? i.q);
    const where = scope || unread ? `for ${unread ? "unread " : ""}emails${scope}` : "through your email";
    const did = n !== null ? `Read ${n} ${unread ? "unread " : ""}${n === 1 ? "email" : "emails"}${scope}` : `Looked ${where}`;
    return [did, `look ${where}`];
  }],
  [/^(archive|label)$|(label|archive|file|move|mark).*(mail|email|thread)/i, () => ["Tidied your inbox", "tidy your inbox"]],
  [/(create|add|schedule|book).*(event|meeting|calendar)/i, (i) => {
    const t = quoted(i.title ?? i.summary);
    const what = t ? `${t} to your calendar` : "an event to your calendar";
    return [`Added ${what}`, `add ${what}`];
  }],
  [/(update|move|change|reschedule).*(event|meeting)/i, () => ["Changed an event on your calendar", "change an event on your calendar"]],
  [/(delete|cancel|remove).*(event|meeting)/i, () => ["Removed an event from your calendar", "remove an event from your calendar"]],
  [/(read|list|get|check|find|search).*(calendar|event|availability|free|busy)/i, (_i, r) => {
    const n = resultCount(r?.content);
    return [n !== null ? `Checked your calendar (${plural(n, "event")})` : "Checked your calendar", "check your calendar"];
  }],
  [/web_?search|search_?web|^search$/i, (i) => {
    const q = quoted(i.query ?? i.q);
    const what = q ? ` for ${q}` : "";
    return [`Searched the web${what}`, `search the web${what}`];
  }],
  [/fetch|read_?page|browse|open_?url|web_?read/i, (i) => {
    const host = hostOf(i.url);
    const what = host ? `a page on ${host}` : "a web page";
    return [`Read ${what}`, `read ${what}`];
  }],
  [/(create|add).*(task|todo|to_do)/i, (i) => {
    const t = quoted(i.title);
    const what = t ? `a to-do: ${t}` : "a to-do";
    return [`Added ${what}`, `add ${what}`];
  }],
  [/(list|read|get|check).*(task|todo|to_do)/i, () => ["Checked your to-dos", "check your to-dos"]],
  [/(update|change|edit|complete).*(task|todo|to_do)/i, () => ["Updated a to-do", "update a to-do"]],
  [/(create|write|add).*(doc|note|page)/i, (i) => {
    const t = quoted(i.title);
    const what = t ? `a note: ${t}` : "a note";
    return [`Wrote ${what}`, `write ${what}`];
  }],
  [/(create|add|set|schedule).*(routine|trigger|reminder)/i, (i) => {
    const t = quoted(i.title);
    const what = t ? `a routine: ${t}` : "a routine";
    return [`Set up ${what}`, `set up ${what}`];
  }],
  [/(list|read|get|check).*(routine|trigger|reminder)/i, () => ["Checked your routines", "check your routines"]],
  [/(cancel|stop|delete|remove).*(routine|trigger|reminder)/i, () => ["Stopped a routine", "stop a routine"]],
  [/(read|get|open).*(doc|note)/i, () => ["Read a note", "read a note"]],
  [/(replace|update|edit).*(doc|note)/i, () => ["Updated a note", "update a note"]],
  [/^remember$/i, () => ["Made a note to remember", "make a note to remember"]],
  [/^recall$/i, () => ["Remembered what you told me", "recall what you told me"]],
  [/lookup/i, () => ["Looked something up", "look something up"]],
  // Whole words only: "ask" inside "tasks" is not a question to the person.
  [/(^|_)(ask|approval|decide)(_|$)/i, () => ["Asked for your go-ahead", "ask for your go-ahead"]],
];

// A tool's own name is jargon; one nobody has phrased yet stays neutral.
const UNPHRASED: Words = ["Did a step", "do a step"];

/** How a call came out: no result yet is `pending` (running, or parked on
 *  the person's approval); an error result the engine wrote is `declined` or
 *  `not_run` as @platform/agent's `toolResultOutcome` reads it; any other
 *  error is `failed`. */
export type StepOutcome = "done" | "pending" | "declined" | "not_run" | "failed";

export function stepOutcome(result?: ToolResultLike): StepOutcome {
  if (!result) return "pending";
  if (!result.is_error) return "done";
  return toolResultOutcome(resultText(result.content)) ?? "failed";
}

/** A result's words, whether stored as text, as JSON text, or as the
 *  engine's content blocks. */
function resultText(raw: unknown): string {
  const v = parsedObject(raw) ?? raw;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : typeof b === "string" ? b : "")).join(" ");
  return typeof raw === "string" ? raw : "";
}

/** One tool call as one plain line that never claims more than happened:
 *  done reads in the past tense, anything else says it did not happen.
 *  `asking` says a pending call waits on the person's approval (the caller
 *  knows the turn is parked rather than running). */
export function stepText(call: ToolCallLike, result?: ToolResultLike, opts: { asking?: boolean } = {}): string {
  const outcome = stepOutcome(result);
  // A tool's own sentence is past tense, so it speaks only for a step that
  // happened; the result's own sentence speaks for the result whatever it is.
  const own = (result?.summary ?? (outcome === "done" ? call.summary : undefined))?.trim();
  if (own) return own;
  const [did, todo] = phrased(call, result) ?? UNPHRASED;
  switch (outcome) {
    case "done":
      return did;
    case "pending":
      return opts.asking ? `Waiting for your go-ahead to ${todo}` : `Waiting to ${todo}`;
    case "declined":
      return `Didn't ${todo} (you said no)`;
    case "not_run":
      return `Didn't ${todo}`;
    case "failed":
      return `Couldn't ${todo}`;
  }
}

/** The vocabulary's two forms for a call, or null for a tool nobody has
 *  phrased yet. */
function phrased(call: ToolCallLike, result?: ToolResultLike): Words | null {
  const name = call.name ?? "";
  return PHRASES.find(([pattern]) => pattern.test(name))?.[1](parsedInput(call.input), result) ?? null;
}

/** What a call would do, as an approval asks it ("Send an email to Dana"):
 *  the same words its step will say once it runs or is declined, so the
 *  question and the receipt name the action one way. Null for a tool nobody
 *  has phrased yet, which the caller names by its own label. */
export function stepAsk(call: ToolCallLike): string | null {
  const words = phrased(call);
  return words ? words[1][0].toUpperCase() + words[1].slice(1) : null;
}

/** How many steps a folded run shows by default. */
export const STEPS_SHOWN = 4;

/** The steps a run shows, and how many sit behind "N more steps", for a run
 *  that shows at most `limit`. A fold that would hide a single step shows it
 *  instead. */
export function visibleSteps<T>(steps: T[], open: boolean, limit = STEPS_SHOWN): { shown: T[]; more: number } {
  if (open || steps.length - limit <= 1) return { shown: steps, more: 0 };
  const shown = steps.slice(0, limit - 1);
  return { shown, more: steps.length - shown.length };
}

/** "3 more steps", "1 step": a count of steps in plain words. */
export function stepCount(n: number, more = false): string {
  return `${n} ${more ? "more " : ""}${n === 1 ? "step" : "steps"}`;
}
