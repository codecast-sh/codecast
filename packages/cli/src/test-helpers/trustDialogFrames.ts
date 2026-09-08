// Verbatim pane captures of the agents' first-launch trust dialogs.
//
// Two classifiers meet this screen — classifyTmuxLiveState while a message is
// being delivered, and classifyStartedPane while a freshly launched pane is
// still booting — and they used to carry a trust pattern each. The launch one
// knew claude's wording only, so a cold codex pane in an untrusted directory
// read "booting" for its whole discovery budget and never bound (ct-49749).
// One frame, imported by both suites, is what keeps the two rules honest: a
// wording change fails in both places at once.

// `tmux capture-pane -p -J -S -25` from a cold `codex 0.153.4` pane launched in
// an untrusted directory on a private tmux server (ct-49609). The ASCII-art
// splash above the welcome line is elided; it holds no separator run, so the
// extracted live region is identical either way.
export const CODEX_TRUST_PANE = `
  Welcome to Codex, OpenAI's command-line coding agent

> You are in /private/tmp/codecast-test-tmux/ct49609b-37849/untrusted-project

  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt
  injection. Trusting the directory allows project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue`;

// The same pane three seconds after the corrective pressed Enter on the "Yes,
// continue" row (ct-49749). Codex does NOT clear the answered dialog — it
// scrolls into scrollback and the composer paints below it — so the whole
// capture still carries both option rows. A trust rule read over the whole
// capture therefore never stops being true: the pane keeps classifying "trust"
// and every 2s discovery poll presses Enter again at a live composer.
// The pane's trailing blank rows are dropped; every reader trims them.
export const CODEX_TRUST_ACCEPTED_PANE = `  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. Trusting the directory allows project-local config, hooks, and exec policies
  to load.

› 1. Yes, continue
  2. No, quit

  Press enter to continue
╭──────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.153.4)                           │
│                                                      │
│ model:       loading   /model to change              │
│ directory:   /private/var/…/untrusted-project-OIvHwz │
│ permissions: YOLO mode                               │
╰──────────────────────────────────────────────────────╯


› Ask Codex to do anything

  repro default · /private/var/folders/sr/…/untrusted-project-OIvHwz

╭──────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.153.4)                           │
│                                                      │
│ model:       repro   /model to change                │
│ directory:   /private/var/…/untrusted-project-OIvHwz │
│ permissions: YOLO mode                               │
╰──────────────────────────────────────────────────────╯

  Tip: New Build faster with the Desktop app. Run 'codex app' or visit https://chatgpt.com/codex?app-landing-page=true


› Ask Codex to do anything

  repro default · /private/var/folders/sr/…/untrusted-project-OIvHwz`;
