// The columns the lazy gutters (session blame, the language server's lint
// marks, git changes) take, and the empty stand-ins that hold them while their
// modules load. A stand-in sits in its feature's own slot at the real gutter's
// precedence and width, so a file paints with its final layout and the text
// never shifts sideways as features land (see `placeholder` in features.ts).
// The real gutters' themes read the same column styles, so the two cannot
// drift apart.

import { Prec, type Extension } from "@codemirror/state";
import { EditorView, gutter } from "@codemirror/view";
import { EDITOR_FONT } from "./theme";

type ColumnStyle = Record<string, string>;

export const BLAME_GUTTER_CLASS = "cm-blame-gutter";
export const BLAME_GUTTER_COLUMN: ColumnStyle = { width: "26ch", minWidth: "26ch", maxWidth: "26ch", fontFamily: EDITOR_FONT, fontSize: "11px" };

export const LINT_GUTTER_CLASS = "cm-gutter-lint";
export const LINT_GUTTER_COLUMN: ColumnStyle = { width: "10px" };

export const GIT_GUTTER_CLASS = "cm-git-gutter";
export const GIT_GUTTER_COLUMN: ColumnStyle = { width: "8px" };

function standIn(className: string, column: ColumnStyle, prec: (e: Extension) => Extension): Extension {
  return [prec(gutter({ class: className })), EditorView.theme({ [`.${className}`]: column })];
}

const same = (e: Extension) => e;

/** Blame's gutter is Prec.high: leftmost, before the line numbers. */
export const blameGutterStandIn = standIn(BLAME_GUTTER_CLASS, BLAME_GUTTER_COLUMN, Prec.high);
/** @codemirror/lint's gutter sits at default precedence. */
export const lintGutterStandIn = standIn(LINT_GUTTER_CLASS, LINT_GUTTER_COLUMN, same);
/** Git's gutter is Prec.lowest: rightmost, next to the text. */
export const gitGutterStandIn = standIn(GIT_GUTTER_CLASS, GIT_GUTTER_COLUMN, Prec.lowest);
