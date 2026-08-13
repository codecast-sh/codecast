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
  /** Lowercased effort label ("low" | "medium" | "high" | "xhigh" | "max" |
   * "ultracode" on CC 2.1.220+) or null. */
  effort: string | null;
  /** The highlighted model takes no effort at all ("○ Effort not supported
   * for Haiku" on CC 2.1.220) — the switch should commit the model and skip
   * the effort adjustment, not fail. */
  effortUnsupported: boolean;
}

// A menu row: optional ❯ highlight marker, number, dot, label. The label runs
// until a 2+ space column gap (the description column) or end-of-line on
// narrow panes. Wrapped description lines carry no "N." and are skipped.
const ROW_RE = /^\s*(❯)?\s*(\d+)\.\s+(.+?)(?:\s{2,}.*)?$/;
// CC 2.1.220 grew two picker-only stops: low → medium → high → xHigh → max →
// Ultracode (wrapping). All six must parse or the Right-press effort walk
// reads null on the new stops and can misjudge the ladder.
const EFFORT_ROW_RE = /^\s*[^\w\s]?\s*(low|medium|xhigh|high|max|ultracode)\s+effort\b/i;

export function parseModelPicker(paneText: string): PickerState {
  const rows: PickerRow[] = [];
  let effort: string | null = null;
  let effortUnsupported = false;
  let sawHeader = false;
  for (const line of paneText.split("\n")) {
    if (/Select model/i.test(line)) {
      sawHeader = true;
      // Header resets state: captures can include an EARLIER picker render
      // higher in the scrollback; only rows after the LAST header count.
      rows.length = 0;
      effort = null;
      effortUnsupported = false;
      continue;
    }
    if (!sawHeader) continue;
    if (/Effort not supported/i.test(line)) {
      effortUnsupported = true;
      effort = null;
      continue;
    }
    const effortMatch = line.match(EFFORT_ROW_RE);
    if (effortMatch) {
      effort = effortMatch[1].toLowerCase();
      effortUnsupported = false;
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
  return { visible: sawHeader && rows.length >= 2, rows, effort, effortUnsupported };
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

/**
 * The submitted "/model" stranded in the composer: CC eats the Enter meant to
 * submit it — the slash-command popup absorbs it as a completion-select, or a
 * mid-render CC coalesces it into the paste burst (the same class
 * verifyTmuxSubmitAfterPaste handles for message injection). Test only the
 * last few pane lines: the transcript echo of an earlier /model run renders
 * the identical "❯ /model" higher up.
 */
export const STRANDED_MODEL_COMMAND_RE = /^\s*[❯›]\s*\/model\s*$/m;

export function isStrandedModelCommand(paneTail: string, args?: string): boolean {
  if (!args) return STRANDED_MODEL_COMMAND_RE.test(paneTail);
  const esc = args.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*[❯›]\\s*\\/model\\s+${esc}\\s*$`, "m").test(paneTail);
}

/** The session-only commit echo, tolerant of ANSI bold wrapping. */
export const SESSION_ONLY_COMMIT_RE =
  /Set model to .*for this session only/i;

/**
 * How many session-only commit echoes the pane shows. "Is the echo present"
 * is ambiguous — echoes of earlier switches linger in scrollback, and on a
 * short transcript the fresh echo renders far above the composer (observed on
 * CC 2.1.220: a committed switch was misread as failed, so the web reverted
 * its optimistic chip while the tmux session silently ran the new model).
 * Callers count before committing and wait for the count to increase.
 */
export function countSessionOnlyCommits(paneText: string): number {
  return (paneText.match(new RegExp(SESSION_ONLY_COMMIT_RE.source, "gi")) ?? []).length;
}

/**
 * Any /model switch echo — the picker's session-only commit AND the one-shot
 * form ("Set model to Fable 5 and saved as your default for new sessions").
 * Same staleness trap as countSessionOnlyCommits: echoes of earlier switches
 * linger in scrollback, so callers count before acting and wait for the count
 * to increase.
 */
export const MODEL_SET_ECHO_RE = /Set model to \S+/i;

export function countModelSetEchoes(paneText: string): number {
  return (paneText.match(new RegExp(MODEL_SET_ECHO_RE.source, "gi")) ?? []).length;
}

// Committing a model switch on a conversation WITH HISTORY pops a cache
// warning before applying ("This conversation is cached for the current
// model… ❯ 1. Yes, switch to Opus 4.8 / 2. No, go back"). Only the live pane
// tail should be tested — transcripts of earlier switches linger in scrollback.
export const SWITCH_CONFIRM_DIALOG_RE = /1\.\s*Yes, switch to[\s\S]*2\.\s*No, go back/i;

export function isSwitchConfirmDialog(paneTail: string): boolean {
  return SWITCH_CONFIRM_DIALOG_RE.test(paneTail);
}
