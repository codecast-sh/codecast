// Pure parsing/planning for driving Claude Code's /model picker from tmux.
//
// Why the picker and not the one-shot commands: `/model <x>` and `/effort <x>`
// both REWRITE THE USER'S GLOBAL DEFAULT (~/.claude/settings.json), while the
// picker's `s` commit is session-scoped — and it commits the ←/→ effort
// adjustment in the same stroke ("Set model to Sonnet 4.6 for this session
// only with max effort"). The menu is dynamic (rows shift, the current model
// gains a ✔, numbered digits INSTANT-COMMIT AS DEFAULT), so the daemon parses
// the live pane and navigates by arrows — never digits, never Enter (Enter =
// save as default).
//
// Pane shape this parses (CC 2.1.x):
//    Select model
//      1. Default (recommended)  Opus 4.8 with 1M context · Best for …
//    ❯ 2. Fable ✔                Fable 5 · Most capable …
//    ● High effort (default) ←/→ to adjust
//    Enter to set as default · s to use this session only · Esc to cancel

export interface PickerRow {
  num: number;
  /** Row label with the current-model ✔ stripped (e.g. "Sonnet (1M context)"). */
  label: string;
  highlighted: boolean;
  current: boolean;
}

export interface PickerState {
  visible: boolean;
  rows: PickerRow[];
  /** Lowercased effort label ("low" | "medium" | "high" | "max") or null. */
  effort: string | null;
}

// A menu row: optional ❯ highlight marker, number, dot, label. The label runs
// until a 2+ space column gap (the description column) or end-of-line on
// narrow panes. Wrapped description lines carry no "N." and are skipped.
const ROW_RE = /^\s*(❯)?\s*(\d+)\.\s+(.+?)(?:\s{2,}.*)?$/;
const EFFORT_ROW_RE = /^\s*[^\w\s]?\s*(low|medium|high|max)\s+effort\b/i;

export function parseModelPicker(paneText: string): PickerState {
  const rows: PickerRow[] = [];
  let effort: string | null = null;
  let sawHeader = false;
  for (const line of paneText.split("\n")) {
    if (/Select model/i.test(line)) {
      sawHeader = true;
      // Header resets state: captures can include an EARLIER picker render
      // higher in the scrollback; only rows after the LAST header count.
      rows.length = 0;
      effort = null;
      continue;
    }
    if (!sawHeader) continue;
    const effortMatch = line.match(EFFORT_ROW_RE);
    if (effortMatch) {
      effort = effortMatch[1].toLowerCase();
      continue;
    }
    const m = line.match(ROW_RE);
    if (!m) continue;
    const rawLabel = m[3].trim();
    const current = /[✔✓]\s*$/.test(rawLabel);
    rows.push({
      num: parseInt(m[2], 10),
      label: rawLabel.replace(/\s*[✔✓]\s*$/, ""),
      highlighted: m[1] === "❯",
      current,
    });
  }
  return { visible: sawHeader && rows.length >= 2, rows, effort };
}

/**
 * Arrow-key plan to move the highlight onto the row matching `menuMatch`.
 * Positive = Down presses, negative = Up presses. Null when the target row
 * isn't in the menu or no row is highlighted (caller surfaces the error).
 */
export function planModelNavigation(state: PickerState, menuMatch: string): number | null {
  const re = new RegExp(menuMatch, "i");
  const targetIdx = state.rows.findIndex((r) => re.test(r.label));
  const hiIdx = state.rows.findIndex((r) => r.highlighted);
  if (targetIdx < 0 || hiIdx < 0) return null;
  return targetIdx - hiIdx;
}

/** The session-only commit echo, tolerant of ANSI bold wrapping. */
export const SESSION_ONLY_COMMIT_RE =
  /Set model to .*for this session only/i;

// Committing a model switch on a conversation WITH HISTORY pops a cache
// warning before applying ("This conversation is cached for the current
// model… ❯ 1. Yes, switch to Opus 4.8 / 2. No, go back"). Only the live pane
// tail should be tested — transcripts of earlier switches linger in scrollback.
export const SWITCH_CONFIRM_DIALOG_RE = /1\.\s*Yes, switch to[\s\S]*2\.\s*No, go back/i;

export function isSwitchConfirmDialog(paneTail: string): boolean {
  return SWITCH_CONFIRM_DIALOG_RE.test(paneTail);
}
