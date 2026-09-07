/**
 * `cast computer` — drive a native macOS app through its accessibility tree.
 *
 * Registration only. Every action reaches its implementation through a dynamic
 * `import("./run.js")`, so `cast --help`, `cast status` and every unrelated
 * verb load none of the client, the permission probe or the embedded helper
 * bundle. A static import here would put that graph on the startup cost of the
 * whole CLI for a feature almost no invocation uses.
 *
 * `cast browser` stays the tool for web pages. This is for native apps, and for
 * a browser only when the work is at the window level: the address field, a
 * native dialog, a permission sheet.
 */

import type { Command } from "commander";
import type { ComputerOptions, ComputerRunDeps, ComputerVerb } from "./run.js";

/** Injected by the tests so a verb can run against a fake helper client. */
export type ComputerCommandDeps = ComputerRunDeps;

function run(verb: ComputerVerb, o: ComputerOptions, deps: ComputerCommandDeps): Promise<void> {
  return import("./run.js").then(({ runComputerVerb }) => runComputerVerb(verb, o, deps));
}

/** `--app` plus the window selector, on every verb that targets a window. */
function targetFlags<T extends Command>(cmd: T): T {
  return cmd
    .requiredOption("--app <selector>", "bundle id (com.apple.TextEdit), app name (TextEdit), or pid:1234")
    .option("--window-id <id>", "target this window id (from list-windows)")
    .option("--window-index <n>", "target this window index (from list-windows)");
}

/**
 * The observation flags.
 *
 * `--restore-window` is the ONLY flag in this feature that may move the human's
 * screen, and it is an observation flag rather than a verb on purpose: an agent
 * has to ask for the raise, and the raise is stamped so the daemon's focus
 * sentinel does not bounce it. No click, no keystroke and no snapshot raises
 * anything on its own.
 */
function observeFlags<T extends Command>(cmd: T): T {
  return cmd
    .option("--no-screenshot", "skip the capture (faster, and the tree is usually the answer)")
    .option("--restore-window", "raise and unminimize the target window first — the only flag that takes the human's screen")
    .option("--no-inline", "write the screenshot but do not show it in the conversation")
    .option("--json", "machine-readable result; the screenshot is written to a 0600 file and reported as a path");
}

export function registerComputerCommand(program: Command, deps: ComputerCommandDeps = {}): void {
  const computer = program
    .command("computer")
    .description("Drive a native macOS app through its accessibility tree (cast browser is still the tool for web pages)")
    .addHelpText(
      "after",
      `
The loop: read an indexed tree, act on an element by its index, read the tree
the action returns. Indexes are sparse and go stale — never infer one from
elementCount, and take a fresh snapshot after navigation, scrolling or a delay.

  cast computer list-apps                            what is running
  cast computer get-app-state --app com.apple.TextEdit
  cast computer set-value --app com.apple.TextEdit --element-index 12 --value hi
  cast computer click --app Slack --element-index 34

Focus: no verb raises a window. Synthetic input (type-text, press-key, hotkey,
a coordinate click) needs the target window focused already and otherwise fails
with window_not_focused; prefer set-value and perform-secondary-action, which
work on a background window and take nothing from the human. Pass
--restore-window only when the screen genuinely has to move.

Secrets go in on stdin (--text-stdin, --value-stdin), never in argv, where the
shell history and every other user's \`ps\` output would keep them.

Behaviour: do not push, submit a form, send a message, buy anything, delete
data or change account settings unless the human asked for that action.

Coordinates are window-local: action x/y = screenshot pixel / screenshot.scale.
`,
    )
    // A group with an action handler receives unknown operands instead of
    // failing on them, so `cast computer bogus` would print the whole help to
    // STDOUT and exit 0 — which is exactly what agents scrape (see
    // failUnknownCommand in index.ts). An invented verb has to fail loudly, on
    // stderr, with nothing usable on stdout.
    .action(() => {
      const operands = computer.args.filter((arg) => !arg.startsWith("-"));
      if (!operands.length) return computer.outputHelp();
      console.error(`error: unknown command 'computer ${operands[0]}'`);
      console.error("Run 'cast computer --help' for the list of verbs.");
      (deps.exit ?? process.exit)(1);
    });

  computer
    .command("capabilities")
    .description("What this helper supports on this machine (materializes it on first run)")
    .option("--json", "as JSON")
    .action((o) => run("capabilities", o, deps));

  computer
    .command("permissions")
    .description("Read the helper's Accessibility and Screen Recording grants, and open the pane to grant one")
    .option("--id <id>", "accessibility | screenshots — opens System Settings for that grant")
    .option("--reset", "clear both TCC rows for the helper (a stale deny needs an explicit way out)")
    .option("--json", "as JSON")
    .action((o) => run("permissions", o, deps));

  computer
    .command("list-apps")
    .description("Running apps with a bundle id and a pid")
    .option("--json", "as JSON")
    .action((o) => run("list-apps", o, deps));

  computer
    .command("list-windows")
    .description("Visible windows of one app, with the id and index the other verbs target")
    .requiredOption("--app <selector>", "bundle id, app name, or pid:1234")
    .option("--json", "as JSON")
    .action((o) => run("list-windows", o, deps));

  observeFlags(
    targetFlags(computer.command("get-app-state").description("The indexed accessibility tree of one window, plus a screenshot")),
  ).action((o) => run("get-app-state", o, deps));

  observeFlags(
    targetFlags(computer.command("click").description("Click an element by index, or a window-local coordinate"))
      .option("--element-index <n>", "element index from the latest get-app-state")
      .option("--x <n>", "window-local x (screenshot pixel / screenshot.scale)")
      .option("--y <n>", "window-local y")
      .option("--click-count <n>", "1, 2 or 3 presses")
      .option("--mouse-button <button>", "left | right | middle")
      .option("--modifiers <chord>", "modifiers only, e.g. CmdOrCtrl or CmdOrCtrl+Shift"),
  ).action((o) => run("click", o, deps));

  observeFlags(
    targetFlags(
      computer
        .command("perform-secondary-action")
        .description("Run one of an element's advertised Secondary Actions (no focus needed)"),
    )
      .requiredOption("--element-index <n>", "element index from the latest get-app-state")
      .requiredOption("--action <name>", "exactly as the element's Secondary Actions list it"),
  ).action((o) => run("perform-secondary-action", o, deps));

  observeFlags(
    targetFlags(computer.command("scroll").description("Scroll an element or a window-local point"))
      .requiredOption("--direction <direction>", "up | down | left | right")
      .option("--element-index <n>", "element index from the latest get-app-state")
      .option("--x <n>", "window-local x")
      .option("--y <n>", "window-local y")
      .option("--pages <n>", "how many pages to scroll"),
  ).action((o) => run("scroll", o, deps));

  observeFlags(
    targetFlags(computer.command("type-text").description("Type into the focused element of a FOCUSED window"))
      .option("--text <text>", "the text to type")
      .option("--text-stdin", "read the text from stdin — the only safe route for a secret"),
  ).action((o) => run("type-text", o, deps));

  observeFlags(
    targetFlags(computer.command("press-key").description("Press one key (Return, Escape, Tab, +) in a FOCUSED window")).requiredOption(
      "--key <key>",
      "one key; use hotkey for a combination",
    ),
  ).action((o) => run("press-key", o, deps));

  observeFlags(
    targetFlags(computer.command("hotkey").description("Press a modifier combination (CmdOrCtrl+A) in a FOCUSED window")).requiredOption(
      "--key <chord>",
      "a modifier and one key, e.g. CmdOrCtrl+A",
    ),
  ).action((o) => run("hotkey", o, deps));

  observeFlags(
    targetFlags(computer.command("paste-text").description("Paste text through the clipboard, restoring what was there"))
      .option("--text <text>", "the text to paste")
      .option("--text-stdin", "read the text from stdin — the only safe route for a secret"),
  ).action((o) => run("paste-text", o, deps));

  observeFlags(
    targetFlags(
      computer.command("set-value").description("Write a value straight into an element — no focus needed, and read back to verify"),
    )
      .requiredOption("--element-index <n>", "element index from the latest get-app-state")
      .option("--value <value>", "the value to write (empty clears the field)")
      .option("--value-stdin", "read the value from stdin — the only safe route for a secret"),
  ).action((o) => run("set-value", o, deps));
}
