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
        const q = questions[Number(k)];
        const id =
          q?.header?.trim() ||
          q?.question?.replace(/\s+/g, " ").trim().slice(0, 60) ||
          `Q${Number(k) + 1}`;
        return `${id}: ${ans}`;
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
