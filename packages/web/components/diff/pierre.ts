// Codecast's setup for @pierre/diffs: one theme, and how to find a line inside
// a rendered diff.
//
// The theme is a Shiki CSS-variables theme whose token colors are the app's own
// highlight variables, so a diff follows the app's palette and its light/dark
// switch instead of the OS. The diff colors themselves (row backgrounds, word
// emphasis, selection) are set on `diffs-container` in globals.css.
import { DIFFS_TAG_NAME, registerCustomCSSVariableTheme } from "@pierre/diffs";
import type { DiffLineAnchor } from "../../lib/patchParser";

export const DIFF_THEME = "codecast";

registerCustomCSSVariableTheme(DIFF_THEME, {
  foreground: "var(--sol-text)",
  background: "transparent",
  "token-constant": "var(--hljs-number)",
  "token-string": "var(--hljs-string)",
  "token-comment": "var(--hljs-comment)",
  "token-keyword": "var(--hljs-keyword)",
  "token-parameter": "var(--hljs-variable)",
  "token-function": "var(--hljs-function)",
  "token-string-expression": "var(--hljs-string)",
  "token-punctuation": "var(--sol-text-muted)",
  "token-link": "var(--hljs-type)",
});

// Pierre draws each diff inside a shadow root, which a document query cannot
// see into. These walk the diffs under `scope` so a page can still find a
// line to scroll to, or read which line sits at the top of a pane.

/** Every rendered line under `scope`, in document order, with its side and number. */
export function diffLineElements(scope: ParentNode): Array<{ el: HTMLElement; anchor: DiffLineAnchor }> {
  const out: Array<{ el: HTMLElement; anchor: DiffLineAnchor }> = [];
  for (const host of scope.querySelectorAll<HTMLElement>(DIFFS_TAG_NAME)) {
    for (const el of host.shadowRoot?.querySelectorAll<HTMLElement>("[data-code] [data-line]") ?? []) {
      const lineNumber = Number(el.dataset.line);
      if (!Number.isFinite(lineNumber)) continue;
      const side = el.dataset.lineType === "change-deletion" ? "LEFT" : "RIGHT";
      out.push({ el, anchor: { side, lineNumber } });
    }
  }
  return out;
}

/** The rendered line an anchor names, if the diff under `scope` shows it. */
export function findDiffLine(scope: ParentNode, anchor: DiffLineAnchor): HTMLElement | null {
  return diffLineElements(scope).find(({ anchor: a }) => a.side === anchor.side && a.lineNumber === anchor.lineNumber)?.el ?? null;
}
