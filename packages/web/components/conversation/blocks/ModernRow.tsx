// The Modern style's one row anatomy for the transcript (CONV-24). Tool calls,
// `cast` command cards, system rows, compaction, workflow events and the
// permission and decision records each keep their own markup, and name its
// parts with data attributes:
//
//   data-cc-row="<family>"   the row (tool, cast, system, workflow, task, todo,
//                            compaction, permission, decision, message, …)
//   data-cc-row-head         its one line (a disclosure when it carries aria-expanded)
//     data-cc-row-icon       16px glyph (an empty one is a status dot)
//     data-cc-row-lead       a wrapper of icon and verb that Modern flattens
//     data-cc-row-verb       what happened, in words (Read, Edited, Ran, Searched)
//     data-cc-row-object     what it happened to: a path, a command, an id (mono)
//     data-cc-row-text       the same slot when it is a sentence (sans)
//     data-cc-row-tag        a label that rides along (a type, a status word)
//     data-cc-row-meta       the quiet result or status, at the right
//     data-cc-row-hint       an "expand" / "collapse" word the chevron replaces
//     data-cc-row-rule       a divider's line, dropped in Modern
//   data-cc-row-detail       what opens below, on a tinted panel
//   data-cc-row-sub          what the row carries in the open (a comment's body)
//   data-cc-row-list         a checklist under the row (todos)
//   data-cc-row-card         a card answered in place under the row
//   data-cc-row-foot         the row's own links under it
//   data-cc-row-actions      the row's own fix on its line (Retry, Send again), before the result
//   data-cc-row-tone         "error" (red, the result says what failed) or "warn"
//   data-cc-block            content a person reads: the header row over a tinted
//                            panel (ModernQuietBlock: a plan, a structured result)
//   data-cc-divider          a captioned rule (TimelineRule); Modern drops its lines
//   data-cc-path             a path cut in the middle (PathText): the name stays
//
// Further families since: a folded run of tool calls (group, ModernReceipt),
// thinking and watches (ModernEventRows), failures (error, ModernApiErrorRow,
// the undelivered row), dividers, created entities, chat sends and flows. What
// asks the person (ModernAsk) is the one card, never a row.
//
// The look lives in app/globals.css under .modern-style ("MODERN · ROWS"):
// one line, a chevron drawn from aria-expanded, rows tight with no card
// around each. Classic and Minimal never read these attributes, so they draw
// exactly what they drew before. What the markup cannot say by itself (the
// verb a tool call reads as, and the result at its right) is lib/modernRow;
// its glyph is here.

import {
  AppWindow,
  Bot,
  FilePen,
  FilePlus2,
  FileText,
  Globe,
  ListTodo,
  Puzzle,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { RowKind } from "../../../lib/modernRow";

export { PathText } from "./PathText";

const ICONS: Record<RowKind, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  write: FilePlus2,
  shell: SquareTerminal,
  search: Search,
  fetch: Globe,
  web: Globe,
  browser: AppWindow,
  agent: Bot,
  skill: Sparkles,
  todo: ListTodo,
  mcp: Puzzle,
  tool: Wrench,
};

/** A tool row's 16px glyph (Modern only: ToolBlock draws it under useIsModernStyle). */
export function RowIcon({ kind }: { kind: RowKind }) {
  const Icon = ICONS[kind];
  return <Icon data-cc-row-icon aria-hidden className="w-4 h-4 shrink-0" strokeWidth={1.75} />;
}
