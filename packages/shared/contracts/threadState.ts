// The pinned thread state: the agent's own standing answer to "where does this
// thread stand right now?", written with `cast state` and rendered pinned above
// the composer and truncated on the inbox card.
//
// Everything here is shared by the three layers that must agree on it: the CLI
// (which normalizes the text before sending it), the Convex mutation (which
// stores it), and the web (which renders it and shows how stale it is). PURE
// isomorphic data — no Node or DOM APIs.

/** Longest state we store. Past this the text stops being a glance and becomes
 * reading, which is what the transcript is for. The CLI truncates rather than
 * rejecting, so a long write still lands. */
export const THREAD_STATE_MAX_CHARS = 1200;

/** Messages written since the state was set, past which the UI stops presenting
 * it as current. The first step dims it, the second calls it stale. Counted in
 * transcript messages — tool calls included — so a single busy agent turn is a
 * few tens of them. The thresholds sit well above that: a state should survive
 * the turn that wrote it and a couple after, and only look doubtful once the
 * thread has genuinely run past it. */
export const THREAD_STATE_AGING_MSGS = 60;
export const THREAD_STATE_STALE_MSGS = 200;

/** Messages after which the agent's own reminder hook asks it to refresh the
 * state (once per stretch — `cast state` re-arms it). Sits well under the
 * aging step so a maintained state never reaches "doubtful" in the UI. The
 * hook counts user + assistant entries in the local transcript, the same unit
 * the UI's "N messages since" is measured in. */
export const THREAD_STATE_NUDGE_MSGS = 20;

/** Transcript messages after which a session that has NEVER declared a state
 * is asked ONCE, at Stop, to say who acts next (`cast state --status …`). A
 * quick exchange stays quiet; a thread this long is one the inbox will file,
 * and the agent's own declaration beats any classifier reading its prose. */
export const THREAD_STATE_RECRUIT_MSGS = 40;

/** Time is the weaker signal — a thread parked overnight on a CI run has not
 * changed, so the clock only takes over when the thread is quiet for long. */
export const THREAD_STATE_AGING_MS = 12 * 60 * 60 * 1000;
export const THREAD_STATE_STALE_MS = 48 * 60 * 60 * 1000;

export type ThreadStateFreshness = "fresh" | "aging" | "stale";

/** The declared state of the work, set by the agent alongside the text — the
 * agent's answer to "who acts next?": still moving, waiting on the human,
 * finished, or parked on a machine wake. Declared rather than parsed from the
 * prose — "Blocked: nothing" would defeat any keyword heuristic.
 *
 * "done" and "dormant" are SETTLE VERDICTS: when the turn that declared them
 * ends, the daemon settles the agent's status to the same word (instead of
 * plain idle), and the inbox files the session under Done / Dormant instead of
 * Needs Input. The verdict covers exactly that one settle. */
export type ThreadStateStatus = "working" | "blocked" | "done" | "dormant";

/** Human label for each status, shared so the panel chip, the inbox card and
 * the CLI print the same words. */
export const THREAD_STATE_STATUS_LABEL: Record<ThreadStateStatus, string> = {
  working: "In progress",
  blocked: "Needs input",
  done: "Complete",
  dormant: "Dormant",
};

/** Map loose spellings (CLI flag input, older rows) onto the enum. Returns null
 * for anything unrecognized so callers can reject or fall back explicitly. */
export function parseThreadStateStatus(input: string | null | undefined): ThreadStateStatus | null {
  const word = (input ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (["working", "in-progress", "progress", "wip", "active"].includes(word)) return "working";
  if (["blocked", "needs-input", "input", "waiting", "stuck"].includes(word)) return "blocked";
  if (["done", "complete", "completed", "finished", "delivered"].includes(word)) return "done";
  if (["dormant", "parked", "asleep", "sleeping", "waiting-on"].includes(word)) return "dormant";
  return null;
}

export interface ThreadStateFields {
  thread_state?: string | null;
  thread_state_at?: number | null;
  thread_state_msg_count?: number | null;
  thread_state_status?: string | null;
}

/**
 * Trim, collapse runs of blank lines, and cap the length. Returns "" for text
 * that is empty once trimmed — callers treat that as a clear.
 */
export function normalizeThreadState(input: string): string {
  const lines = input.replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd());
  // Drop the indentation the whole block shares — a heredoc written inside an
  // indented shell block carries it accidentally — while keeping the RELATIVE
  // indentation that makes nested bullets read as nested.
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.length - line.trimStart().length);
  const common = indents.length ? Math.min(...indents) : 0;
  const collapsed = lines
    .map((line) => line.slice(common))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (collapsed.length <= THREAD_STATE_MAX_CHARS) return collapsed;
  return collapsed.slice(0, THREAD_STATE_MAX_CHARS - 1).trimEnd() + "…";
}

/**
 * The one line that stands in for the whole state on an inbox card. Takes the
 * first non-empty line, drops a leading bullet, and drops a leading label
 * ("Status:", "Goal:") — on a card the label is noise, since the line IS the
 * status. The convention puts what the session is working on here unlabeled.
 */
export function threadStateHeadline(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line
    .replace(/^[-*•]\s*/, "")
    .replace(/^(Status|State|Goal):\s*/i, "")
    .trim();
}

/** One line of a state after its headline. `label` is the word before the
 * colon: `You`, `Done` or `Next` in the shape agents are asked to write, or
 * whatever an older note used (`Status`, `Blocked`, `Note`). Null when the
 * line carries none. */
export interface ThreadStateRow {
  label: string | null;
  text: string;
}

/** A label is one capitalized word, or one and a lowercase second ("Likely
 * cause"): short enough that a sentence with a colon in it stays a sentence. */
const ROW_LABEL = /^([A-Z][A-Za-z]{0,11}(?: [a-z]{1,11})?):\s+(\S.*)$/;

/**
 * The state as the panel lays it out: every line after the headline, one row
 * each. A workflow station's fenced json report is left out: it is for the
 * station's edges to route on, and it stays whole in `thread_state_result`.
 */
export function threadStateRows(text: string): ThreadStateRow[] {
  const lines = withoutJsonBlocks(text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.slice(1).map((line) => {
    const m = line.replace(/^[-*•]\s*/, "").match(ROW_LABEL);
    return m ? { label: m[1], text: m[2].trim() } : { label: null, text: line };
  });
}

/**
 * The one line a card shows for the whole state: the ask when the state holds
 * one (`You:`, or an older note's `Blocked:`), else the headline. A `Status:`
 * line takes the slot only under a `Goal:` headline: elsewhere it is mostly
 * what already happened, and on a blocked card it used to push the ask out.
 */
export function threadStateCardLine(text: string, rows: ThreadStateRow[] = threadStateRows(text)): string {
  const ask = rows.find((r) => r.label === "You" || r.label === "Blocked");
  if (ask) {
    const { prose, command } = threadStateAskParts(ask.text);
    return (prose || command || "").replace(/`/g, "");
  }
  // A first line labeled `Goal:` names the work rather than where it stands;
  // on such a note the `Status:` line is the one that says that.
  const status = rows.find((r) => r.label === "Status");
  if (status && /^[-*•]?\s*Goal:/i.test(text.trimStart())) return status.text;
  return threadStateHeadline(text);
}

/** An ask split from the command that ends it ("paste it: `cmd`"): a card
 * shows the words, and the panel gives the command a line and a copy button. */
export function threadStateAskParts(text: string): { prose: string; command: string | null } {
  const m = text.match(/^(.*?)[\s:]*`([^`]+)`\s*$/);
  return m ? { prose: m[1], command: m[2] } : { prose: text, command: null };
}

/**
 * How much the thread has moved since the state was written. `messagesSince` is
 * null when we can't tell (an older row stored no count), which the UI renders
 * as "no counter" rather than "0" — claiming freshness we can't prove is the
 * one failure this whole feature cannot afford.
 */
export function threadStateFreshness(
  fields: ThreadStateFields,
  liveMessageCount: number,
  now: number,
): { freshness: ThreadStateFreshness; messagesSince: number | null; ageMs: number | null } {
  const writtenAt = fields.thread_state_at ?? null;
  const writtenCount = fields.thread_state_msg_count ?? null;
  const ageMs = writtenAt == null ? null : Math.max(0, now - writtenAt);
  const messagesSince =
    writtenCount == null ? null : Math.max(0, liveMessageCount - writtenCount);

  let freshness: ThreadStateFreshness = "fresh";
  if (messagesSince != null && messagesSince >= THREAD_STATE_STALE_MSGS) freshness = "stale";
  else if (ageMs != null && ageMs >= THREAD_STATE_STALE_MS) freshness = "stale";
  else if (messagesSince != null && messagesSince >= THREAD_STATE_AGING_MSGS) freshness = "aging";
  else if (ageMs != null && ageMs >= THREAD_STATE_AGING_MS) freshness = "aging";

  return { freshness, messagesSince, ageMs };
}

/** True when the row carries a usable pinned state. */
export function hasThreadState(fields: ThreadStateFields | null | undefined): boolean {
  return !!fields?.thread_state && fields.thread_state.trim().length > 0;
}

/** The patch that takes a pinned state down: all four fields unset together,
 * so no writer can leave a status or a count behind without its text. Used by
 * `cast state clear`, by the enqueue of a human's message (the declaration of
 * who acts next has been answered), and by the web store's optimistic clear. */
/** Longest result kept beside a state: a station's report, not a transcript. */
export const THREAD_STATE_RESULT_MAX_CHARS = 32_000;

/**
 * A state's fenced json block, whole: what a workflow station reports for its
 * edges to route on. The display text is capped at THREAD_STATE_MAX_CHARS and
 * a long report's block would be cut; this keeps it. The last block wins. Null
 * when there is none, it does not parse, or it is past the result cap.
 */
export function threadStateResult(text: string): string | null {
  const blocks = jsonBlocks(text);
  const last = blocks[blocks.length - 1]?.body;
  return last && last.length <= THREAD_STATE_RESULT_MAX_CHARS ? last : null;
}

/** Each fenced json block whose body parses, from its opening fence to the end
 * of its closing one. */
function jsonBlocks(text: string): { from: number; to: number; body: string }[] {
  // A block closes at the first fence after which its body parses: the json's own strings may hold fences (a markdown
  // proposal), and a report piped from a file without a final newline closes on the json's last line.
  const blocks: { from: number; to: number; body: string }[] = [];
  for (const open of text.matchAll(/```json[ \t]*\n/g)) {
    const from = open.index! + open[0].length;
    for (let at = text.indexOf("```", from); at !== -1; at = text.indexOf("```", at + 3)) {
      const body = text.slice(from, at).trim();
      try {
        JSON.parse(body);
      } catch {
        continue;
      }
      blocks.push({ from: open.index!, to: at + 3, body });
      break;
    }
  }
  return blocks;
}

/** The text with its json reports cut out, including one the display cap
 * truncated mid-block (it no longer parses, so it runs to the end). */
function withoutJsonBlocks(text: string): string {
  let out = "";
  let at = 0;
  for (const block of jsonBlocks(text)) {
    if (block.from < at) continue;
    out += text.slice(at, block.from);
    at = block.to;
  }
  return (out + text.slice(at)).replace(/```json[\s\S]*$/, "");
}

export function clearedThreadStateFields(): {
  thread_state: undefined;
  thread_state_at: undefined;
  thread_state_msg_count: undefined;
  thread_state_status: undefined;
  thread_state_result: undefined;
} {
  return {
    thread_state: undefined,
    thread_state_at: undefined,
    thread_state_msg_count: undefined,
    thread_state_status: undefined,
    thread_state_result: undefined,
  };
}
