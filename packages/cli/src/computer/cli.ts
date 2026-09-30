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
import { commandGroup } from "../commandGroups.js";
import { commandTree, unknownCommandNextStep } from "../commandSuggestion.js";
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
function observeFlags<T extends Command>(cmd: T, kind: "snapshot" | "action" = "snapshot"): T {
  const shot =
    kind === "snapshot"
      ? cmd.option("--no-screenshot", "skip the capture (faster, and the tree is usually the answer)")
      : cmd
          .option("--screenshot", "also capture the window after the action (off by default: the output says what changed)")
          .option("--no-screenshot", "the default for an action; kept so older scripts still parse");
  return shot
    .option("--full-resolution", "capture at the display's full pixel density (for small text); coordinates are then pixels / scale")
    .option("--find <text>", "print only elements matching this text (or /regex/), with their ancestors")
    .option("--under <index>", "print only the subtree under this element index")
    .option("--restore-window", "raise and unminimize the target window first — the only flag that takes the human's screen")
    .option("--no-inline", "write the screenshot but do not show it in the conversation")
    .option("--json", "machine-readable result; the screenshot is written to a 0600 file and reported as a path");
}

/** The element a verb acts on: an index from the tree, or a name resolved against a fresh one. */
function elementFlags<T extends Command>(cmd: T, required = false): T {
  return cmd
    .option("--element-index <n>", `element index from the latest get-app-state${required ? " (or use --element)" : ""}`)
    .option("--element <query>", "the element by name, e.g. \"Sign\" or \"button Save\"; several matches are listed, never guessed")
    .option("--nth <n>", "with --element, take the nth of several matches (1 based)");
}

export function registerComputerCommand(program: Command, deps: ComputerCommandDeps = {}): void {
  // Every other group hands its unknown subcommand to the guarded suggester
  // through commander's unknownCommand hook (index.ts). That hook fires only
  // for a group with NO action handler, and this group has one — so without
  // this call a typo under `cast computer` is the one place in the tree that
  // gets no next step at all. The suggester is what keeps the recovery safe:
  // it offers siblings only, and `computer setup` (the destructive verb here)
  // only to a token one edit away from it. ct-49879.
  const failUnknownVerb = (typed: string): void => {
    console.error(`error: unknown command 'computer ${typed}'`);
    const nextStep = unknownCommandNextStep(commandTree(program), ["computer", typed]);
    if (nextStep) console.error(nextStep);
    console.error("Run 'cast computer --help' for the list of verbs.");
    (deps.exit ?? process.exit)(1);
  };

  const computer = program
    .command("computer")
    .description(commandGroup("computer").description)
    .addHelpText(
      "after",
      `
The loop: read the tree once, act on elements by name or index, and read what
each action changed (it prints a diff; "No change" means it was ignored).
Indexes are sparse and go stale, so prefer names: --element "Save".

  cast computer setup                                grant the two permissions, once, with a human
  cast computer list-apps                            what is running
  cast computer get-app-state --app com.apple.TextEdit
  cast computer find --app com.apple.Preview "Sign"  just the matching elements
  cast computer click --app Slack --element "Send"
  cast computer set-value --app com.apple.TextEdit --element-index 12 --value hi
  cast computer do --app com.apple.Preview "click Sign" "wait Created" shot

Focus: no verb raises a window. Keys, typing and mouse clicks go to the target
app directly when it is in the background, so the human can keep working in
another app. Pass --restore-window only when the screen genuinely has to move.

Secrets go in on stdin (--text-stdin, --value-stdin), never in argv, where the
shell history and every other user's \`ps\` output would keep them.

Behaviour: do not push, submit a form, send a message, buy anything, delete
data or change account settings unless the human asked for that action.

Coordinates are window-local: action x/y = screenshot pixel / screenshot.scale.

\`cast computer help <verb>\` prints that verb's flags from this binary, so the
guidance in a CLAUDE.md never has to list them and can never describe an older
release than the one about to run.
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
      failUnknownVerb(operands[0]!);
    });

  computer
    .command("capabilities")
    .description("What this helper supports on this machine (materializes it on first run)")
    .option("--json", "as JSON")
    .action((o) => run("capabilities", o, deps));

  computer
    .command("setup")
    .description("Set the helper up and walk a human through both grants (idempotent; nothing opens until they confirm)")
    .option("--yes", "skip the confirm and open the panes — for a script, since nobody is there to answer")
    .action((o) => run("setup", o, deps));

  computer
    .command("permissions")
    .description("Read the helper's Accessibility and Screen Recording grants (reports only; nothing appears on screen)")
    .option("--open-settings", "open System Settings so a human can grant — this takes the front, so ask first")
    .option("--id <id>", "accessibility | screenshots — which grant --open-settings opens")
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
  )
    .option("--diff", "print only what changed since this window's last snapshot")
    .action((o) => run("get-app-state", o, deps));

  targetFlags(computer.command("find").description("Elements matching text, with their ancestors — the cheap way to get an index"))
    .argument("<text>", "text to match (case insensitive), or /regex/")
    .option("--under <index>", "search only under this element index")
    .option("--json", "machine-readable result")
    .action((text: string, o) => run("find", { ...o, find: text }, deps));

  targetFlags(computer.command("wait").description("Wait until text appears in the window (or disappears, or anything changes)"))
    .argument("[text]", "text to wait for (same as --text)")
    .option("--text <text>", "text to wait for, matched like find")
    .option("--gone", "wait for the text to disappear instead")
    .option("--change", "wait for any change in the window's tree")
    .option("--timeout <seconds>", "give up after this long (default 10)")
    .option("--json", "machine-readable result")
    .action((text: string | undefined, o) => run("wait", { ...o, text: o.text ?? text }, deps));

  observeFlags(
    elementFlags(targetFlags(computer.command("click").description("Click an element by index or name, or a window-local coordinate")))
      .option("--mouse", "a real mouse click at the element's center instead of its accessibility press (for controls that ignore the press)")
      .option("--x <n>", "window-local x (screenshot pixel / screenshot.scale)")
      .option("--y <n>", "window-local y")
      .option("--click-count <n>", "1, 2 or 3 presses")
      .option("--mouse-button <button>", "left | right | middle")
      .option("--modifiers <chord>", "modifiers only, e.g. CmdOrCtrl or CmdOrCtrl+Shift"),
    "action",
  ).action((o) => run("click", o, deps));

  observeFlags(
    elementFlags(
      targetFlags(
        computer
          .command("perform-secondary-action")
          .description("Run one of an element's advertised Secondary Actions (no focus needed)"),
      ),
      true,
    ).requiredOption("--action <name>", "exactly as the element's Secondary Actions list it"),
    "action",
  ).action((o) => run("perform-secondary-action", o, deps));

  observeFlags(
    elementFlags(targetFlags(computer.command("drag").description("Press on an element or point, move, and release on another")))
      .option("--x <n>", "window-local x to press at")
      .option("--y <n>", "window-local y to press at")
      .option("--to-element <query>", "drop on this element, by name or #index")
      .option("--to-element-index <n>", "drop on this element index")
      .option("--to-x <n>", "window-local x to release at")
      .option("--to-y <n>", "window-local y to release at"),
    "action",
  ).action((o) => run("drag", o, deps));

  observeFlags(
    elementFlags(targetFlags(computer.command("scroll").description("Scroll an element or a window-local point")))
      .requiredOption("--direction <direction>", "up | down | left | right")
      .option("--x <n>", "window-local x")
      .option("--y <n>", "window-local y")
      .option("--pages <n>", "how many pages to scroll"),
    "action",
  ).action((o) => run("scroll", o, deps));

  observeFlags(
    targetFlags(computer.command("type-text").description("Type into the focused element (a background window takes it without taking the front)"))
      .option("--text <text>", "the text to type")
      .option("--text-stdin", "read the text from stdin — the only safe route for a secret"),
    "action",
  ).action((o) => run("type-text", o, deps));

  observeFlags(
    targetFlags(computer.command("press-key").description("Press one key (Return, Escape, Tab, +) in the target window")).requiredOption(
      "--key <key>",
      "one key; use hotkey for a combination",
    ),
    "action",
  ).action((o) => run("press-key", o, deps));

  observeFlags(
    targetFlags(computer.command("hotkey").description("Press a modifier combination (CmdOrCtrl+A) in the target window")).requiredOption(
      "--key <chord>",
      "a modifier and one key, e.g. CmdOrCtrl+A",
    ),
    "action",
  ).action((o) => run("hotkey", o, deps));

  observeFlags(
    targetFlags(computer.command("paste-text").description("Paste text through the clipboard, restoring what was there"))
      .option("--text <text>", "the text to paste")
      .option("--text-stdin", "read the text from stdin — the only safe route for a secret"),
    "action",
  ).action((o) => run("paste-text", o, deps));

  observeFlags(
    elementFlags(
      targetFlags(
        computer.command("set-value").description("Write a value straight into an element — no focus needed, and read back to verify"),
      ),
      true,
    )
      .option("--value <value>", "the value to write (empty clears the field)")
      .option("--value-stdin", "read the value from stdin — the only safe route for a secret"),
    "action",
  ).action((o) => run("set-value", o, deps));

  targetFlags(computer.command("do").description("Run several steps against one app in one go — much faster than separate commands"))
    .argument("[steps...]", "steps, or - to read one per line from stdin")
    .option("--keep-going", "carry on after a step fails")
    .addHelpText(
      "after",
      `
Steps read the way the window does, and each takes the single command's flags:
  cast computer do --app com.apple.Preview - <<'EOF'
  click "Sign"
  wait "Created January"
  action "insert signature" "Created January"
  press Return
  shot
  EOF

  click "Save" | click #56 | click "Row" --mouse | click --x 10 --y 20
  action <name> [element]   set <element> <value>   scroll <direction> [element]
  drag <from> <to>          each a name, #index, or x,y in window points
  type <text>   paste <text>   press <key>   hotkey <chord>
  find <text>   (a bare click or action next acts on what it found)
  wait <text> [--gone] [--change] [--timeout s]   snapshot [--find t]   shot   sleep <ms>`,
    )
    .action((steps: string[], o) =>
      import("./batch.js").then(({ runComputerDo }) => runComputerDo(steps, o, deps)),
    );

  // Commander only wires its implicit `help [command]` when the parent has no
  // action handler, and this group needs one to make an invented verb fail
  // loudly. So the escape hatch every other cast group gets for free is
  // registered by hand — `cast computer help <verb>` renders the same flags
  // the verb itself declares, which is why the guidance snippet points here
  // instead of listing flags that would drift from the binary.
  computer
    .command("help")
    .description("Print one verb's flags, straight from this binary (`cast computer help click`)")
    .argument("[verb]", "the verb to document; omit it for the list of verbs")
    .action((verb: string | undefined) => {
      if (!verb) return computer.outputHelp();
      const target = computer.commands.find(
        (c) => c.name() === verb || c.aliases().includes(verb),
      );
      if (!target) return failUnknownVerb(verb);
      target.outputHelp();
    });
}
