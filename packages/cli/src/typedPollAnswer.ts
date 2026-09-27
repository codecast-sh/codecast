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

type TypedPrompt = { options: Array<{ label: string }>; isConfirmation?: boolean };

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function typedPollAnswer(prompt: TypedPrompt, content: string): string | null {
  const text = norm(content);
  if (!text || prompt.options.length === 0) return null;

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
    if (idx < 0) idx = labels.findIndex(l => text.includes(l) || l.includes(text));
  }
  if (idx < 0) return null;
  return JSON.stringify({ __cc_poll: true, keys: [String(idx + 1)], display: prompt.options[idx].label });
}
