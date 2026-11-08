// The answer a person gives to an interactive menu (an AskUserQuestion, a plan
// approval, a slash command's picker), as the web and phone send it: a JSON
// message marked __cc_poll carrying the keys to press, or prose to type after
// declining the menu (web lib/pollPayload.ts builds it). The tmux path presses
// the keys; the Claude SDK path reads them as answers (claudeSdk/pollAnswer.ts).

export type PollMessage = { keys?: string[]; steps?: Array<{ key: string; text?: string }>; text?: string; display?: string; multi?: boolean };

export function parsePollMessage(content: string): PollMessage | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.__cc_poll && (Array.isArray(parsed.keys) || Array.isArray(parsed.steps) || typeof parsed.text === "string")) return parsed;
  } catch {}
  return null;
}

// A free-text answer to an AskUserQuestion menu. Claude Code's question menu has no
// inline text slot, so the only way to enter free text is to decline the whole menu
// (Escape) and type the answer at the prompt — which discards every menu selection. The
// web sends such an answer as a top-level `text` with no menu keys; pre-2026-06-27 builds
// embedded it inside `steps` (one step per `text`). BOTH are a decline: do it ONCE up
// front, then type. Doing it per-step (the old behavior) declined the menu mid-loop and
// spilled the remaining option digits into the freshly-reopened prompt box (the "211"
// bug). The OTHER text shape — menu keys PLUS `poll.text` (e.g. plan feedback, where
// option 4 opens a feedback field) — is NOT a decline: those keys drive a menu whose
// final option opens the text input, so the text lands in the field, not at the prompt.
//
// Returns the text to type after the decline (newlines flattened — a literal LF reads as
// Enter in the TUI and submits early, which is why the normal paste path flattens too; the
// middot keeps multi-answer prose readable on one line), or null when this isn't a decline.
export function pollDeclineText(poll: PollMessage): string | null {
  const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map(k => ({ key: k }));
  const menuSteps = steps.filter(s => !s.text);
  const embeddedText = steps.filter(s => s.text).map(s => s.text!).join("\n\n");
  const isDecline = (poll.text != null && menuSteps.length === 0) || (embeddedText !== "" && poll.text == null);
  if (!isDecline) return null;
  return (poll.text ?? embeddedText).replace(/\r?\n+/g, "  ·  ").trim();
}

// The menu-navigation steps of a poll (the option keystrokes), excluding any step that
// carries embedded free text (those decline the menu — see pollDeclineText).
export function pollMenuSteps(poll: PollMessage): Array<{ key: string; text?: string }> {
  const steps: Array<{ key: string; text?: string }> = poll.steps || (poll.keys || []).map(k => ({ key: k }));
  return steps.filter(s => !s.text);
}
