// The one table of destructive `cast` commands. Two consumers read it, so the
// marking cannot drift: the unknown-command suggester (failUnknownCommand in
// index.ts) must never propose one of these from a typo, and the commands that
// gate themselves behind a confirmation read that gate from here instead of
// each writing its own prompt. ct-49545.

/** What a command demands before it is allowed to act. */
export type DestructiveConfirm =
  // The caller must pass --yes; without it the command refuses and prints the
  // exact line to re-run.
  | { mode: "require-flag"; warning: string }
  // The command asks on the terminal; --yes skips the question.
  | { mode: "prompt"; warning: string };

export type DestructiveCommand = {
  /** Registered command path, root-relative: ["doc", "delete"]. */
  path: readonly string[];
  /** The gate this table puts in front of the command. Absent means this table
   *  adds none — either the command acts immediately (`kill`, `stop`), or it
   *  already owns a better gate of its own (`computer setup`). */
  confirm?: DestructiveConfirm;
};

// Paths are the canonical registered names. Commander carries the aliases, and
// the suggester reads them from there, so they are not repeated here. A guard
// test (destructiveCommands.test.ts) fails when a path stops existing.
export const DESTRUCTIVE_COMMANDS: readonly DestructiveCommand[] = [
  { path: ["kill"] },
  { path: ["stop"] },
  {
    path: ["uninstall"],
    confirm: {
      mode: "prompt",
      warning: "This will remove cast, its daemon, auto-start config, and all local data.",
    },
  },
  { path: ["workspace", "destroy"] },
  { path: ["keys", "rm"] },
  { path: ["vault", "rm"] },
  { path: ["label", "rm"] },
  { path: ["accounts", "rm"] },
  { path: ["anchor", "rm"] },
  { path: ["chat", "stop"] },
  { path: ["trigger", "cancel"] },
  { path: ["task", "drop"] },
  { path: ["plan", "drop"] },
  { path: ["plan", "kill"] },
  {
    path: ["doc", "delete"],
    confirm: { mode: "require-flag", warning: "This permanently deletes the document." },
  },
  { path: ["hosts", "rm"] },
  { path: ["browser", "stop"] },
  { path: ["integrations", "remove"] },
  // The one `cast computer` verb that changes the machine rather than reading
  // it: it installs the helper app and opens System Settings panes, so a typo
  // must not be answered with it. No `confirm` here because setup.ts already
  // asks, and asks better — it names the grants that are actually missing,
  // `--yes` skips it, and with no terminal to answer it refuses to open
  // anything. A second, blanker prompt from this table would ask twice and then
  // drift from the real one. ct-49790, ct-49848.
  //
  // Deliberately NOT listed: `capabilities`, which materializes the same helper
  // but is idempotent, installs only codecast's own signed app, and is the verb
  // `cast doctor` tells a stuck human to run — the suggester should offer it
  // freely. Nor the input verbs (`click`, `type-text`, `press-key`, `hotkey`,
  // `paste-text`, `set-value`, `scroll`, `perform-secondary-action`), which
  // change state in OTHER apps and are the most consequential thing here. They
  // are the feature itself: asking on every invocation would break every agent
  // that uses it, and marking them would make the suggester reluctant to
  // propose the verbs people type most. What restrains them is the behaviour
  // rule in the guidance snippet and the two macOS grants, not this table.
  { path: ["computer", "setup"] },
];

const key = (path: readonly string[]): string => path.join(" ");

const BY_PATH = new Map(DESTRUCTIVE_COMMANDS.map((cmd) => [key(cmd.path), cmd]));

/** Is this exact command path destructive? */
export function isDestructivePath(path: readonly string[]): boolean {
  return BY_PATH.has(key(path));
}

/** What the caller must do before the command may act. */
export type ConfirmGate =
  | { kind: "pass" }
  | { kind: "refuse"; lines: string[] }
  | { kind: "ask"; question: string };

/**
 * Read one command's gate off the table. Pure, so the wording is testable
 * without a terminal.
 *
 * `args` are the command's own operands, echoed back into the re-run line so
 * the refusal is copy-pasteable.
 */
export function destructiveGate(
  path: readonly string[],
  opts: { yes?: boolean; args?: readonly string[] } = {},
): ConfirmGate {
  const cmd = BY_PATH.get(key(path));
  if (!cmd) {
    throw new Error(`destructiveGate: '${key(path)}' is not in DESTRUCTIVE_COMMANDS`);
  }
  if (!cmd.confirm || opts.yes) return { kind: "pass" };
  if (cmd.confirm.mode === "prompt") {
    return { kind: "ask", question: `${cmd.confirm.warning} Continue? [y/N] ` };
  }
  const rerun = ["cast", ...path, ...(opts.args ?? []), "--yes"].join(" ");
  return {
    kind: "refuse",
    lines: [`${cmd.confirm.warning} Re-run with --yes to confirm:`, `  ${rerun}`],
  };
}

/**
 * Run the gate: refuse, ask, or return. Exits the process when the caller has
 * not confirmed — a declined prompt is not an error (0), a missing --yes is (1).
 */
export async function requireDestructiveConfirm(
  path: readonly string[],
  opts: { yes?: boolean; args?: readonly string[] } = {},
): Promise<void> {
  const gate = destructiveGate(path, opts);
  if (gate.kind === "pass") return;
  if (gate.kind === "refuse") {
    for (const line of gate.lines) console.error(line);
    process.exit(1);
  }
  const readline = await import("node:readline");
  const iface = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => iface.question(gate.question, resolve));
  iface.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log("Aborted");
    process.exit(0);
  }
}
