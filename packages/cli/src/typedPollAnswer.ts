// Turn a person's typed reply to a scraped terminal menu into the same poll
// payload the web card sends when that option is clicked, or null when the
// text names no option (it then delivers as an ordinary message).
//
// A choice is always sent as the option's number key, never as a count of Down
// presses: the menu's highlight does not start on the first row (/model opens
// on the CURRENT model), so counted arrows land on the wrong option. The
// injector already knows how to press a number key on every menu shape,
// numbered or not.
//
// A bare number picks that row. It must be tried before labels, because labels
// contain digits too: "1" otherwise matched "Fable 5.1" in the /model menu.
//
// Text names an option by the option's own words: the whole label, or its
// opening words. A word met in the middle of a label names nothing: "continue"
// read as "Wait here, then continue automatically at Oct 5 at 3pm".
//
// A limit dialog is never answered by text. It is a park whose options are
// billing actions and a day-long wait; delivery dismisses it and types the
// message at the composer instead.

import { isUsageLimitDialog } from "@codecast/shared/contracts";
import { isAskUserQuestionMenu } from "./interactivePrompt.js";

type TypedPrompt = { options: Array<{ label: string }>; isConfirmation?: boolean };

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function typedPollAnswer(prompt: TypedPrompt, content: string): string | null {
  const text = norm(content);
  if (!text || prompt.options.length === 0) return null;
  if (isUsageLimitDialog(prompt.options.map(o => o.label))) return null;

  if (prompt.isConfirmation) {
    const labelHead = (i: number) => prompt.options[i] ? norm(prompt.options[i].label).split(" (")[0] : null;
    const confirmHead = labelHead(0);
    const cancelHead = labelHead(1);
    if (/^(continue|enter|yes|ok|confirm|proceed|accept|y|1)$/.test(text) || (confirmHead && text.includes(confirmHead))) {
      return JSON.stringify({ __cc_poll: true, keys: ["Enter"], display: "Continue" });
    }
    if (/^(cancel|escape|esc|no|quit|n|2)$/.test(text) || (cancelHead && text.includes(cancelHead))) {
      return JSON.stringify({ __cc_poll: true, keys: ["Escape"], display: "Cancel" });
    }
    return null;
  }

  const labels = prompt.options.map(o => norm(o.label));
  let idx = -1;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n >= 1 && n <= labels.length) idx = n - 1;
  } else {
    idx = labels.indexOf(text);
    if (idx < 0) idx = labels.findIndex(l => text.includes(l) || (l.startsWith(text) && /\W/.test(l.charAt(text.length))));
  }
  if (idx < 0) return null;
  return JSON.stringify({ __cc_poll: true, keys: [String(idx + 1)], display: prompt.options[idx].label });
}

// A person's message while the agent's question menu is open answers it.
// Text that names an option picks it; any other text is a free-text answer,
// the one the card's own text box sends: the menu is declined and the words
// typed at the prompt (pollDeclineText). Held instead, the message waited on a
// card the person had chosen not to use, and everything queued behind it
// waited too (Alex Green: "Sorry typo I meant do all your suggestions" on
// 2026-10-25, then "Update" and "Latest?" for 17 hours on 2026-10-31). The
// terminal's own dialogs (a permission confirmation, the safeguards
// interstitial, a limit park) are not the agent asking, and keep their hold.
export function typedMenuReply(prompt: TypedPrompt & { unnumbered?: boolean }, content: string): string | null {
  if (!isAskUserQuestionMenu(prompt)) return null;
  const named = typedPollAnswer(prompt, content);
  if (named) return named;
  const text = content.trim();
  return text ? JSON.stringify({ __cc_poll: true, text }) : null;
}
