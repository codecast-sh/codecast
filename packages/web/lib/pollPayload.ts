// The AskUserQuestion answer wire format, in one place.
//
// Answering a Claude Code poll from the web means driving its TUI menu by
// remote control: the payload carries either the KEYS to press, or prose to
// type after declining the menu. The protocol below was verified in tmux and
// has burned us before (see the "211" bug note inside), so both the inline
// conversation card and the decision queue import this rather than each
// keeping a copy that can drift.
//
// Mirror parsers: packages/cli/src/daemon.ts (parsePollMessage) and
// packages/convex/convex/pendingMessages.ts (isControlMessage).

export type PollQuestion = {
  question: string;
  header?: string;
  // Explanatory text a terminal dialog prints between its title and its
  // options (scraped by the daemon's parseSelectDialog). Agent questions have none.
  detail?: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect?: boolean;
  isConfirmation?: boolean;
};

export type PollSelection = { key: string; label: string; text?: string };
export type PollSelections = Record<number, PollSelection[]>;

// Claude Code appends two synthetic affordance rows to every AskUserQuestion menu —
// "Type something" (free text) and "Chat about this" (escape hatch). On a prompt scraped
// from the terminal (no JSONL sidecar) they arrive as bare options; the web has its own
// "Other" free-text affordance, so rendering them too is redundant clutter. Mirrors the
// daemon's SYNTHETIC_OPTION so scraped polls render as clean as sidecar-sourced ones.
export const SYNTHETIC_POLL_OPTION = /^(?:type something\.?|chat about this)$/i;

/**
 * The key an option maps to. Index is the option's position in the UNFILTERED
 * option array — hiding a synthetic row must not shift the digits the TUI
 * expects. A confirmation dialog has no digits: its two rows are Enter/Escape.
 */
export function pollKeyForOption(index: number, isConfirmation?: boolean): string {
  if (isConfirmation) return index === 0 ? "Enter" : "Escape";
  return String(index + 1);
}

export function buildPollPayload(questions: PollQuestion[], sels: PollSelections): string {
  const isMultiQuestion = questions.length > 1;
  const anyMultiSelect = questions.some((q) => q.multiSelect);
  const needsSubmit = isMultiQuestion || anyMultiSelect;

  const sorted = Object.keys(sels).sort((a, b) => Number(a) - Number(b));
  const hasText = sorted.some((k) => sels[Number(k)].some((s) => s.text !== undefined));
  const display = sorted.map((k) => sels[Number(k)].map((s) => s.label).join(", ")).join(", ");

  if (hasText) {
    // Claude Code's AskUserQuestion menu only accepts the listed options — there's no
    // inline free-text slot. So a custom ("Other") answer can't be entered through the
    // menu, and answering even one question with free text means the menu can't be used
    // for the others either: the only way to enter free text is to decline the whole
    // set (Escape) and type at the prompt, which discards every menu pick. Convert all
    // answers to prose and send it as the daemon's decline-then-type `text` so the agent
    // still gets every answer. (Driving a digit per question and Escaping for the text
    // declined the poll mid-loop and spilled the leftover option digits into the
    // reopened prompt box — the "211" bug, 2026-06-27.)
    const text = sorted
      .map((k) => {
        const qSels = sels[Number(k)];
        const ans = qSels.map((s) => s.text ?? s.label).join(", ");
        if (sorted.length === 1) return ans;
        return `${typedAnswerId(questions[Number(k)], Number(k))}: ${ans}`;
      })
      .join("\n\n");
    return JSON.stringify({ __cc_poll: true, text, display });
  }

  // Key protocol (verified in tmux against Claude Code 2.1.201): on a multiSelect
  // question a digit TOGGLES that option's checkbox and the menu stays up; Right
  // advances to the next tab. Any multi-question or multiSelect form then parks on a
  // "Review your answers" pane whose cursor sits on "1. Submit answers" — the trailing
  // Enter confirms it. `multi` tells the daemon these digits are toggles, so its
  // digit-didn't-advance heuristic must not "confirm" them with Enter (which would
  // re-toggle the highlighted row).
  const keys: string[] = [];
  for (const k of sorted) {
    const qSels = sels[Number(k)];
    if (questions[Number(k)]?.multiSelect) {
      keys.push(...qSels.map((s) => s.key).sort((a, b) => Number(a) - Number(b)), "Right");
    } else {
      keys.push(qSels[0].key);
    }
  }
  if (needsSubmit) keys.push("Enter");
  return JSON.stringify({
    __cc_poll: true,
    keys,
    display,
    ...(anyMultiSelect ? { multi: true } : {}),
  });
}

/**
 * A prose answer. There is no inline free-text slot in the menu, so this is the
 * decline-then-type form — the same `text` shape buildPollPayload emits when any
 * selection carries custom text. Callers must not hand-roll this object: the
 * daemon and convex parsers key off these exact fields.
 */
export function buildFreeTextPayload(text: string): string {
  const trimmed = text.trim();
  return JSON.stringify({ __cc_poll: true, text: trimmed, display: trimmed });
}

/** Single-select, single-question answer — the queue's one-key path. */
export function buildSingleAnswerPayload(
  question: PollQuestion,
  optionIndex: number
): string {
  const key = pollKeyForOption(optionIndex, question.isConfirmation);
  const label = (question.options[optionIndex]?.label ?? "").replace(" (Recommended)", "");
  return buildPollPayload([question], { 0: [{ key, label }] });
}

// Text Claude Code may print right after an answer's closing quote: the next
// answer, the chosen option's preview or the user's notes, or the closing sentence.
const ANSWER_TERMINATORS = [", \"", " selected preview:", " user notes:", ". You can now"];

/**
 * The answers an AskUserQuestion result reports, keyed by question text. Claude Code
 * writes them as `"<question>"="<answer>"` without escaping quotes inside either, so a
 * generic `"…"="…"` match loses any question or answer holding a `"`. Locate each
 * known question's own marker instead, prefer an exact option label after it, and
 * otherwise end the answer at the first quote followed by a known terminator.
 */
export function parsePollAnswers(
  questions: Array<Pick<PollQuestion, "question" | "options">>,
  content: string | undefined
): Record<string, string> {
  const answers: Record<string, string> = {};
  if (!content) return answers;
  // A question scraped from the terminal is closed by the daemon
  // (closeSyntheticPrompt) with its own result, naming the app's answer.
  const fromApp = content.match(/^Answered from the app: ([^]+)$/)?.[1];
  if (fromApp !== undefined && questions.length === 1) {
    answers[questions[0].question] = fromApp;
    return answers;
  }
  for (const q of questions) {
    const marker = `"${q.question}"="`;
    const at = content.indexOf(marker);
    if (at < 0) continue;
    const start = at + marker.length;
    const rest = content.slice(start);
    const endsAt = (p: number) =>
      p === rest.length - 1 || rest.slice(p + 1) === "." || ANSWER_TERMINATORS.some(t => rest.startsWith(t, p + 1));
    const label = q.options
      .map(o => o.label)
      .sort((a, b) => b.length - a.length)
      .find(l => rest.startsWith(`${l}"`) && endsAt(l.length));
    if (label !== undefined) {
      answers[q.question] = label;
      continue;
    }
    for (let p = rest.indexOf('"'); p >= 0; p = rest.indexOf('"', p + 1)) {
      if (endsAt(p)) {
        answers[q.question] = rest.slice(0, p);
        break;
      }
    }
  }
  return answers;
}

/** How a typed multi-question answer names its question ("Shortlist: …"). */
function typedAnswerId(q: PollQuestion | undefined, index: number): string {
  return q?.header?.trim() || q?.question?.replace(/\s+/g, " ").trim().slice(0, 60) || `Q${index + 1}`;
}

/**
 * The answers inside a typed decline (buildPollPayload's `text` form, which the
 * daemon flattens to one line with "  ·  " between answers): a single question
 * takes the whole text, and several are matched back by their `Header: ` prefix.
 */
export function parseTypedPollAnswers(questions: PollQuestion[], text: string | undefined): Record<string, string> {
  const answers: Record<string, string> = {};
  const typed = text?.trim();
  if (!typed || questions.length === 0) return answers;
  if (questions.length === 1) {
    answers[questions[0].question] = typed;
    return answers;
  }
  const ids = questions.map((q, i) => `${typedAnswerId(q, i)}: `);
  let current: string | undefined;
  for (const segment of typed.split(/\s*\n\n\s*| {2}· {2}/)) {
    const i = ids.findIndex((id) => segment.startsWith(id));
    if (i >= 0) {
      current = questions[i].question;
      answers[current] = segment.slice(ids[i].length).trim();
    } else if (current) {
      answers[current] += `  ·  ${segment}`;
    }
  }
  return answers;
}

const DECLINED_RESULT = "The user doesn't want to proceed with this tool use";

type PollTranscriptMessage = {
  role: string;
  content?: string | null;
  tool_results?: Array<{ tool_use_id: string; content: string }>;
};

/**
 * A card answered with free text closes its menu (the result is Claude Code's
 * rejection) and types the answers as the next message. Pair each declined tool
 * id with that message, so the card can show what was answered: the first
 * typed user message after the rejection, past Claude Code's interrupt notice
 * and before the agent speaks again.
 */
export function typedPollAnswerTexts(messages: readonly PollTranscriptMessage[]): Record<string, string> {
  const texts: Record<string, string> = {};
  let declined: string[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      declined = [];
      continue;
    }
    if (msg.role !== "user") continue;
    const rejections = (msg.tool_results ?? []).filter((r) => r.content?.startsWith(DECLINED_RESULT));
    if (rejections.length > 0) {
      declined = rejections.map((r) => r.tool_use_id);
      continue;
    }
    const text = msg.content?.trim();
    if (!text || declined.length === 0 || /^\[Request (?:interrupted|cancelled)/.test(text)) continue;
    for (const id of declined) texts[id] = text;
    declined = [];
  }
  return texts;
}

/**
 * The answers a question card lights up: the ones the tool input carries, else
 * the ones its result reports, else the ones typed after the menu was declined.
 */
export function pollCardAnswers(
  questions: PollQuestion[],
  inputAnswers: Record<string, string> | undefined,
  result: { content?: string; typed_answer?: string } | undefined
): Record<string, string> {
  if (inputAnswers && typeof inputAnswers === "object") return inputAnswers;
  const reported = parsePollAnswers(questions, result?.content);
  return Object.keys(reported).length > 0 ? reported : parseTypedPollAnswers(questions, result?.typed_answer);
}

/**
 * What a question card shows once it closed with no answer anyone can see: the
 * terminal timed the dialog out, someone pressed Esc there, or the agent got a
 * rejection. Null while it is open or when an answer lights up an option. A
 * short single-line result ("Closed in the terminal") is the daemon's own
 * resolution and reads as is; anything longer is Claude Code's prose to the agent.
 */
export function pollClosedLabel(
  result: { content?: string } | undefined,
  answers: Record<string, string>
): string | null {
  if (!result || Object.keys(answers).length > 0) return null;
  const text = (result.content ?? "").trim();
  return text && text.length <= 48 && !text.includes("\n") ? text : "Closed without an answer";
}

/**
 * A terminal dialog that times itself out carries `deniesAt` (epoch ms, read by
 * the daemon off the dialog's own countdown). `left` is the time remaining as
 * M:SS; once it has passed the terminal has denied, whatever the card shows.
 */
export function pollDeadline(deniesAt: number | undefined, now: number): { expired: boolean; left: string } | null {
  if (typeof deniesAt !== "number") return null;
  const ms = Math.max(0, deniesAt - now);
  const s = Math.ceil(ms / 1000);
  return { expired: ms === 0, left: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` };
}

export const POLL_TIMED_OUT = "Timed out in the terminal";
