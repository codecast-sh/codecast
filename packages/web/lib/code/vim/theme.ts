// Vim's cursor, selection and command line in the app's tokens.
// Rules use var(--sol-*) directly, so a theme flip needs no reconfigure.

import { EditorView } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { CODE_CURSOR_BLOCK_VAR, CODE_CURSOR_TEXT_VAR, EDITOR_FONT } from "../theme";

const mix = (token: string, pct: number) => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;
// The core theme sets the block's colors (theme.ts blockCursorColors); the
// fallbacks are reverse video, for an editor without it.
const block = `var(${CODE_CURSOR_BLOCK_VAR}, var(--sol-text))`;
const letter = `var(${CODE_CURSOR_TEXT_VAR}, var(--sol-bg))`;

export const vimTheme = Prec.highest(
  EditorView.theme({
    // The block cursor: a solid cell in normal mode, an outline when unfocused.
    // The engine paints each cell's letter with the character's syntax colour
    // inline, which vanishes on a cell of the same hue (a string under a cyan
    // cursor), so the letter takes the one colour chosen against the cell,
    // with !important to beat the inline style. Half-height cells (replace,
    // operator-pending) are inline-transparent and stay that way.
    ".cm-cursorLayer .cm-fat-cursor": {
      background: block,
      color: `${letter} !important`,
      borderRadius: "1px",
    },
    '.cm-cursorLayer .cm-fat-cursor[style*="color: transparent"]': { color: "transparent !important" },
    "&:not(.cm-focused) .cm-cursorLayer .cm-fat-cursor": {
      background: "none",
      outline: `1px solid ${block}`,
      color: "transparent !important",
    },
    // Visual mode draws through CodeMirror's selection layer.
    ".cm-vimMode .cm-selectionLayer .cm-selectionBackground, &.cm-focused .cm-vimMode .cm-selectionLayer .cm-selectionBackground": {
      background: mix("--sol-cyan", 24),
    },
    // The `:` and `/` command line, and engine messages.
    ".cm-panels .cm-vim-panel": {
      padding: "2px 10px",
      minHeight: "1.6em",
      alignItems: "center",
      fontFamily: EDITOR_FONT,
      fontSize: "12px",
      color: "var(--sol-text)",
      background: "var(--sol-bg-alt)",
      borderTop: `1px solid ${mix("--sol-border", 40)}`,
    },
    ".cm-panels .cm-vim-panel input": {
      font: "inherit",
      color: "var(--sol-text)",
      caretColor: "var(--sol-cyan)",
      background: "transparent",
    },
    // `set list` and `set colorcolumn`.
    ".cm-vimListTab": {
      backgroundImage: `linear-gradient(to right, transparent calc(100% - 1px), ${mix("--sol-text-dim", 35)} 0)`,
    },
    ".cm-trailingSpace": { backgroundColor: mix("--sol-red", 22) },
    ".cm-vimColorColumn": { borderLeft: `1px solid ${mix("--sol-border", 45)}` },
  }),
);
