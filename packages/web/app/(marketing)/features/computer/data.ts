/**
 * Every string on the cast computer page that claims to be CLI output or CLI
 * behaviour. Each one is copied from the CLI and helper sources:
 * packages/cli/src/computer/{format,tree,errors,cli,batch,setup}.ts and
 * packages/cli/native/computer-use-macos (AppBlockList, SecureTextRedaction,
 * AgentCursor). Change them there first.
 */

export const CURSOR_ORANGE = "#ff6b36"; // AgentCursor.swift: rgb(1, 0.42, 0.21)

/** One printed line of a terminal mock. */
export type TermLine = { t: "cmd" | "out" | "dim" | "add" | "rem" | "ok" | "bad" | "head" | "ask"; s: string };

/* ── Hero: an agent signs a PDF in Preview while the human writes in Notes ── */

export type HeroStep = { key: string; label: string; ms: number };

export const HERO_STEPS: HeroStep[] = [
  { key: "idle", label: "start", ms: 1500 },
  { key: "find", label: "find", ms: 3400 },
  { key: "click", label: "click", ms: 3600 },
  { key: "action", label: "action", ms: 3800 },
  { key: "done", label: "hand back", ms: 5600 },
];

/** Terminal lines, each tagged with the hero step it appears in. */
export const HERO_TERM: (TermLine & { step: number })[] = [
  { step: 0, t: "ask", s: "Sign the lease in Preview with my saved signature. Don't save or send it." },
  { step: 1, t: "cmd", s: 'cast computer find --app com.apple.Preview "Sign"' },
  { step: 1, t: "head", s: "Preview (pid 1187, com.apple.Preview)" },
  { step: 1, t: "dim", s: '  Window: id:4127 "Lease renewal.pdf" (1160x1040 @ 60,90)' },
  { step: 1, t: "dim", s: "  Visible elements: 212  Focused: none  Coordinates: window" },
  { step: 1, t: "out", s: "0 standard window Lease renewal.pdf" },
  { step: 1, t: "out", s: "\t3 toolbar" },
  { step: 1, t: "out", s: "\t\t41 button Sign, Secondary Actions: show menu" },
  { step: 2, t: "cmd", s: 'cast computer click --app com.apple.Preview --element "Sign"' },
  { step: 2, t: "ok", s: "Click attempted via accessibility (AXPress), unverified (accessibility action unasserted)." },
  { step: 2, t: "dim", s: "Changes: 3 added, 0 removed" },
  { step: 2, t: "add", s: "+ 88 popover" },
  { step: 2, t: "add", s: "+ 89 button Created January 27, Secondary Actions: insert signature" },
  { step: 2, t: "add", s: "+ 90 button Create Signature" },
  { step: 3, t: "cmd", s: 'cast computer perform-secondary-action --app com.apple.Preview --element "Created January 27" --action "insert signature"' },
  { step: 3, t: "ok", s: "Secondary action attempted via accessibility (insert signature), unverified (accessibility action unasserted)." },
  { step: 3, t: "dim", s: "Changes: 1 added, 3 removed" },
  { step: 3, t: "rem", s: "- 88 popover  (and 2 lines under it)" },
  { step: 3, t: "add", s: "+ 92 image Signature" },
];

export const HUMAN_NOTE = "Offsite, Oct 14\n- book the big room\n- budget sign-off by Friday\n- agenda draft to the team\n- who runs the retro?";

/* ── How it reads a window: a Finder window and its tree ───────────────── */

export type TreeRow = { i: number | null; d: number; s: string; k?: string };

export const FINDER_HEADER = [
  "Finder (pid 749, com.apple.finder)",
  '  Window: id:1514 "Documents" (1070x902 @ 375,32)',
  "  Visible elements: 64  Focused: #31  Coordinates: window",
  "  Truncated: no",
  "  Screenshot skipped (--no-screenshot)",
];

export const FINDER_TREE: TreeRow[] = [
  { i: 0, d: 0, s: "standard window Documents", k: "window" },
  { i: 1, d: 1, s: "split group" },
  { i: 2, d: 2, s: "scroll area, Secondary Actions: scroll up, scroll down", k: "sidebar" },
  { i: 3, d: 3, s: "outline sidebar", k: "sidebar" },
  { i: 7, d: 4, s: "outline row Recents", k: "recents" },
  { i: 8, d: 5, s: "cell Recents, Secondary Actions: open", k: "recents" },
  { i: 10, d: 4, s: "outline row Applications", k: "apps" },
  { i: 11, d: 5, s: "cell Applications, Secondary Actions: open", k: "apps" },
  { i: 13, d: 4, s: "outline row (selected) Documents", k: "docs" },
  { i: 14, d: 5, s: "cell (selected) Documents, Secondary Actions: open", k: "docs" },
  { i: 16, d: 4, s: "outline row Downloads", k: "downloads" },
  { i: 17, d: 5, s: "cell Downloads, Secondary Actions: open", k: "downloads" },
  { i: 24, d: 2, s: "scroll area", k: "list" },
  { i: 31, d: 3, s: "list Documents", k: "list" },
  { i: 32, d: 4, s: "row Lease renewal.pdf", k: "f1" },
  { i: 35, d: 4, s: "row Offsite agenda.key", k: "f2" },
  { i: 38, d: 4, s: "row Invoice 0931.pdf", k: "f3" },
  { i: 40, d: 1, s: "toolbar", k: "toolbar" },
  { i: 41, d: 2, s: "button (disabled) Back", k: "back" },
  { i: 44, d: 2, s: "search field Search", k: "search" },
  { i: null, d: 0, s: "The focused UI element is 31 list Documents." },
];

/* ── Every action says what it changed ─────────────────────────────────── */

export type Outcome = {
  key: string;
  tab: string;
  verdict: "completed" | "attempted" | "ignored";
  cmd: string;
  lines: TermLine[];
  json: string;
  title: string;
  body: string;
};

export const OUTCOMES: Outcome[] = [
  {
    key: "verified",
    tab: "set-value",
    verdict: "completed",
    cmd: 'cast computer set-value --app com.apple.TextEdit --element-index 12 --value "Hi Sam,"',
    lines: [
      { t: "ok", s: "Set value completed via accessibility, verified (value)." },
      { t: "dim", s: "Changes: 1 added, 1 removed" },
      { t: "rem", s: "- 12 text area" },
      { t: "add", s: "+ 12 text area, Value: Hi Sam," },
    ],
    json: '"verification": { "state": "verified", "property": "value" }',
    title: "completed: read back and confirmed",
    body: "set-value writes through accessibility, then the helper reads the element again. The first word is completed only when that read matches. The diff shows the line that moved.",
  },
  {
    key: "attempted",
    tab: "click",
    verdict: "attempted",
    cmd: 'cast computer click --app com.apple.Preview --element "Sign"',
    lines: [
      { t: "ok", s: "Click attempted via accessibility (AXPress), unverified (accessibility action unasserted)." },
      { t: "dim", s: "Changes: 3 added, 0 removed" },
      { t: "add", s: "+ 88 popover" },
      { t: "add", s: "+ 89 button Created January 27, Secondary Actions: insert signature" },
      { t: "add", s: "+ 90 button Create Signature" },
    ],
    json: '"verification": { "state": "unverified", "reason": "accessibility_action_unasserted" }',
    title: "attempted: delivered, and here is the evidence",
    body: "macOS cannot confirm that a press did what a button promises, so a click reads attempted. The diff under it is the proof: a popover with three new elements, and the indexes to use next.",
  },
  {
    key: "ignored",
    tab: "ignored click",
    verdict: "ignored",
    cmd: 'cast computer click --app com.apple.Preview --element-index 57',
    lines: [
      { t: "ok", s: "Click attempted via accessibility (AXPress), unverified (accessibility action unasserted)." },
      { t: "bad", s: "No change in the window's tree. If the action should have changed something, it was probably ignored: try another element, `click --mouse`, or look at a screenshot." },
    ],
    json: '"changes": { "added": [], "removed": [], "focusChanged": false }',
    title: "No change: said in the same breath",
    body: "An app that ignores a press is the usual way UI automation goes quietly wrong. Here the agent learns it from the action's own output, without a second snapshot, and gets told what to try next.",
  },
];

/* ── Input routes and whether they reach a background window ───────────── */

export const ROUTES: { verbs: string; path: string; background: boolean; note: string }[] = [
  { verbs: "set-value, perform-secondary-action, click on a pressable element", path: "accessibility", background: true, note: "Works on a background window and can be verified." },
  { verbs: "type-text, press-key, hotkey", path: "the app's own event queue", background: true, note: "Keys go to the target app, never to the app you are typing in." },
  { verbs: "click --x --y on a background window", path: "accessibility, at that point", background: true, note: "Presses the control under the point without moving your pointer." },
  { verbs: "paste-text", path: "the clipboard", background: true, note: "Your clipboard is restored afterwards. Capped at 16 MiB." },
  { verbs: "click --mouse, drag, a control with no press", path: "a real mouse event", background: false, note: "macOS drops a press on a background window, so this fails with window_not_focused. --restore-window brings it forward, and your pointer goes back where it was." },
];

/* ── Guardrails ────────────────────────────────────────────────────────── */

export const BLOCKED_APPS = ["1Password", "Bitwarden", "Dashlane", "LastPass", "NordPass", "Proton Pass"];

/* ── Errors and their recoveries: verbatim from errors.ts ─────────────── */

export const ERRORS: { code: string; recovery: string[] }[] = [
  { code: "app_not_found", recovery: ["Run `cast computer list-apps` and retry with the exact bundle id.", "A web app such as Gmail is not an app selector: target the desktop browser that contains it.", "If the browser is not listed, open or focus it first."] },
  { code: "app_blocked", recovery: ["Stop. Do not drive this app.", "Choose another target or ask the human to do it."] },
  { code: "window_not_found", recovery: ["Run `cast computer list-windows --app <app>` and target a listed window.", "If the app is listed with no visible window, retry observation once with `--restore-window`.", "cast computer does not launch closed apps."] },
  { code: "window_not_focused", recovery: ["Mouse input reaches only a window in front; keys and typing reach a background one.", "Look for a route that needs no mouse: a keyboard shortcut, a menu item, a Secondary Action, or set-value.", "If only the mouse will do, pass --restore-window, which takes the human's screen; if the message says presses were already delivered, run `get-app-state` first."] },
  { code: "window_stale", recovery: ["Run `cast computer list-windows --app <app>` and choose a current selector.", "Then rerun `get-app-state` before acting."] },
  { code: "element_not_found", recovery: ["Run `cast computer get-app-state --app <app>` again and use an element index from the fresh tree.", "Never infer an index from `elementCount`.", "Never reuse an index after navigation, scrolling, a focus change or a delay."] },
  { code: "element_not_clickable", recovery: ["Choose a parent or child that has a frame.", "Or use window-local coordinates taken from the latest screenshot."] },
  { code: "action_not_supported", recovery: ["Read the element's `Secondary Actions` in a fresh snapshot and use one of those names.", "Or use `click` or `set-value`."] },
  { code: "value_not_settable", recovery: ["Choose a settable element from a fresh snapshot.", "If none accepts a write, focus it and use keyboard input, then inspect the returned state."] },
  { code: "invalid_argument", recovery: ["Fix the flags exactly as the message says.", "Do not retry unchanged."] },
  { code: "action_timeout", recovery: ["Run `get-app-state` first so you know whether the UI changed.", "Then retry with a simpler semantic action, or with `--no-screenshot` if observation is slow.", "Do not repeat the same timed-out action blindly."] },
  { code: "permission_denied", recovery: ["Run `cast computer permissions` to read the grants; it reports and shows nothing on screen.", "To grant, ask the human first: `cast computer permissions --open-settings --id accessibility` takes the front.", "A token or peer failure means the helper belongs to another user or another launch: rerun the command, which relaunches it."] },
  { code: "screenshot_failed", recovery: ["If the tree is enough, rerun with `--no-screenshot`.", "If the message names Screen Recording, `cast computer permissions --open-settings --id screenshots` opens the pane. It takes the front, so ask the human first."] },
  { code: "unsupported_capability", recovery: ["Run `cast computer capabilities` and choose a supported action.", "Or use a semantic alternative such as `set-value` or `click`."] },
  { code: "provider_incompatible", recovery: ["Run `cast computer capabilities`.", "Update codecast; the CLI and the helper it materializes must come from the same release."] },
  { code: "accessibility_error", recovery: ["Run `cast computer capabilities`.", "If the message names Accessibility, `cast computer permissions --open-settings --id accessibility` opens the pane. It takes the front, so ask the human first.", "If it names the helper app, run `cast doctor`.", "Do not loop while availability is unchanged."] },
];

/* ── Command reference: from `cast computer --help` ───────────────────── */

export const VERB_GROUPS: { name: string; verbs: [string, string][] }[] = [
  {
    name: "Set up",
    verbs: [
      ["setup", "Walk a human through both grants. Idempotent; nothing opens until they confirm."],
      ["permissions", "Read the Accessibility and Screen Recording grants. Shows nothing on screen."],
      ["capabilities", "What the helper supports on this machine. Sets it up on first run."],
    ],
  },
  {
    name: "Look",
    verbs: [
      ["list-apps", "Running apps with a bundle id and a pid."],
      ["list-windows", "Visible windows of one app, with the id and index other verbs target."],
      ["get-app-state", "The indexed accessibility tree of one window, plus a screenshot."],
      ["find <text>", "Only the matching elements, with their ancestors."],
      ["wait [text]", "Until text appears, disappears (--gone) or anything changes (--change)."],
    ],
  },
  {
    name: "Act",
    verbs: [
      ["click", "By index, by name or at a window-local point."],
      ["perform-secondary-action", "Run one of an element's advertised Secondary Actions."],
      ["set-value", "Write a value straight into an element and read it back."],
      ["type-text", "Type into the focused element of a background window."],
      ["press-key / hotkey", "One key, or a modifier chord like CmdOrCtrl+A."],
      ["paste-text", "Paste through the clipboard, restoring what was there."],
      ["scroll / drag", "Scroll an element or point; press, move and release."],
    ],
  },
  {
    name: "Batch",
    verbs: [
      ["do [steps...]", "Many steps against one app in one process. - reads them from stdin."],
      ["help <verb>", "That verb's flags, straight from the binary about to run it."],
    ],
  },
];

export const FLAGS: [string, string][] = [
  ["--app <selector>", "Bundle id (preferred), app name, or pid:1234. On Linux, the WM_CLASS."],
  ["--window-id / --window-index", "One window of an app with several, from list-windows."],
  ["--element / --element-index / --nth", "Act by name (several matches are listed, never guessed) or by index."],
  ["--find <text> / --under <index>", "Print part of the tree. /regex/ works too."],
  ["--diff", "get-app-state prints only what changed since this window's last read."],
  ["--json", "Machine-readable. Errors carry code and recovery; actions carry action.verification."],
  ["--screenshot / --no-screenshot", "Snapshots capture by default, actions do not."],
  ["--restore-window", "Raise the target window first. The only flag that takes your screen."],
  ["--no-cursor", "Hide the agent cursor for one action. CODECAST_COMPUTER_CURSOR=0 hides it everywhere."],
  ["--text-stdin / --value-stdin", "Read a secret from stdin, out of shell history and ps."],
  ["--keep-going", "With do: carry on past a failing step."],
];

/* ── Batched flows: the plan is the example in `cast computer help do` ─── */

export const DO_PLAN = ['click "Sign"', 'wait "Created January"', 'action "insert signature" "Created January 27"', "press Return", "shot"];

/** Each step's printed header and, for the actions, its first line (abbreviated). */
export const DO_RESULTS: { step: string; first?: string }[] = [
  { step: 'click "Sign"', first: "Click attempted via accessibility (AXPress), unverified (accessibility action unasserted)." },
  { step: 'wait "Created January"' },
  { step: 'action "insert signature" "Created January 27"', first: "Secondary action attempted via accessibility (insert signature), unverified (accessibility action unasserted)." },
  { step: "press Return" },
  { step: "shot" },
];

/** Step words `do` accepts, from batch.ts ALIASES plus shot and sleep. */
export const DO_WORDS = ["snapshot", "find", "wait", "click", "action", "set", "type", "paste", "press", "hotkey", "scroll", "drag", "shot", "sleep"];

/* ── Setup: why the grants go to a helper, from setup.ts EXPLANATION ─── */

export const GRANTS: { name: string; id: string; why: string }[] = [
  {
    name: "Accessibility",
    id: "accessibility",
    why: "Lets the helper read the window you name and act inside it. Every verb needs it. It goes to the helper and not to your terminal, because macOS attaches a permission to the program that asks, and your terminal runs everything you and every agent type there.",
  },
  {
    name: "Screen Recording",
    id: "screenshots",
    why: "Lets the helper take a picture of the window it just read, so an image comes back beside the text. The text works without it; only the picture fails.",
  },
];

export const PERMISSIONS_OUT = [
  "Computer permissions checked.",
  "  Helper app: ~/.codecast/computer/codecast computer.app",
  "  Permissions: accessibility=granted, screenshots=granted",
];
