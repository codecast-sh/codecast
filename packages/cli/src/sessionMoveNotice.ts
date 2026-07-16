/**
 * The message a moved session's agent receives on the machine it lands on.
 *
 * A move can change four things underneath a running agent at once: the cwd, the
 * code sitting in it, the transcript it remembers, and the account and agent
 * config it runs under. The agent sees none of that happen — it just resumes and
 * acts on assumptions that quietly stopped being true. This composes the one
 * message that tells it, so it re-grounds first.
 *
 * Two rules keep the notice worth reading:
 *
 * 1. Only facts the composing machine verified itself. A destination can check
 *    its own cwd, branch, clone freshness and trim depth. It cannot check the
 *    machine the session left, and when the session crossed into another user's
 *    account it has no access to that machine at all. So every line describes
 *    where the agent IS, never what it lost: "this is a fresh clone holding only
 *    pushed work" is checkable, "your uncommitted files are missing" is a guess.
 *    Same practical warning, but it needs no access to the source.
 *
 * 2. Proportional. A line appears only when that fact actually changed, and a
 *    move that changed nothing material sends nothing at all. A notice that
 *    fires every time with boilerplate trains the agent to skip the next one —
 *    including the one that mattered.
 *
 * Deliberately silent about the transcript: when a resume rebuilds a trimmed
 * history, generateClaudeCodeJsonl already prepends its own [Codecast import]
 * notice naming the original message count, what was kept, and the `cast read`
 * command to recover the omitted middle. That disclosure is better than
 * anything repeated here, and saying it twice is the boilerplate rule 2 exists
 * to prevent.
 */

/** What the destination's working tree actually is. */
export interface CheckoutFacts {
  cwd: string;
  /** True when this machine cloned the repo just now; false when it reused a checkout already here. */
  cloned: boolean;
  remote?: string;
  branch?: string;
}

/** Set only when the session changed hands between accounts. */
export interface AccountFacts {
  fromUser?: string;
  toUser?: string;
}

export interface ReorientationFacts {
  /** Where the session now runs, named as a person would name it. */
  destination: string;
  newCwd: string;
  /** Where it ran before, when the composing machine actually knows. */
  oldCwd?: string;
  /** True when the machine itself changed (false for a same-machine repath). */
  machineChanged: boolean;
  checkout?: CheckoutFacts;
  account?: AccountFacts;
  /** Pre-rendered transfer verification (SSH move only) — kept as a string so
   * this module never depends on the move/transport code. */
  verification?: string;
}

/**
 * Build the notice, or null when nothing material changed and silence is right.
 */
export function reorientationNotice(f: ReorientationFacts): string | null {
  const lines: string[] = [];

  const movedPath = !!f.oldCwd && f.oldCwd !== f.newCwd;
  if (!f.machineChanged && !movedPath && !f.checkout && !f.account) {
    return null;
  }

  lines.push(
    f.machineChanged
      ? `[codecast] This session just moved to a different machine. It now runs on ${f.destination} in ${f.newCwd}${f.oldCwd ? ` (previously ${f.oldCwd})` : ""}.`
      : `[codecast] This session just moved to a different directory: it now runs in ${f.newCwd}${f.oldCwd ? ` (previously ${f.oldCwd})` : ""}.`,
  );

  if (f.verification) {
    lines.push(
      `Code transfer: any uncommitted changes were committed as a wip snapshot on the branch, then pushed. Verification: ${f.verification}.`,
    );
  }

  if (f.checkout?.cloned) {
    const onBranch = f.checkout.branch ? ` and is on branch ${f.checkout.branch}` : "";
    const ofRemote = f.checkout.remote ? ` of ${f.checkout.remote}` : "";
    lines.push(
      `The working tree here is a fresh clone${ofRemote}${onBranch}. Only work that was pushed to that remote is present: anything uncommitted, or committed but not pushed, stayed behind on the previous machine and is NOT here. If you were on a different branch, you are not on it now.`,
    );
  } else if (f.checkout) {
    lines.push(
      `The working tree here is a checkout that already existed on this machine, not a copy of the previous machine's. Its branch and its uncommitted state are its own — do not assume they match what you left.`,
    );
  }

  if (f.account) {
    const to = f.account.toUser ?? "another user";
    const from = f.account.fromUser ? `, not ${f.account.fromUser}'s` : "";
    lines.push(
      `This session now runs under ${to}'s account${from}. The global agent config on this machine — skills, agents, commands, settings — belongs to ${to}; your personal config did not travel and is not here. The project's own CLAUDE.md and AGENTS.md came with the repo, so project rules still apply. Credentials here are ${to}'s.`,
    );
  }

  if (f.machineChanged) {
    lines.push(
      `Processes, ports, and any files outside the working tree from the previous machine are not here.`,
    );
  }

  lines.push(
    `Before you continue, re-ground yourself in whatever way fits the task: confirm the cwd, branch, and code state are what you expect, and check that anything you were relying on actually exists here. If something you need is missing, say so instead of proceeding.`,
  );

  return lines.join("\n");
}

/** The reorientation fields reparentSessionToDevice puts on a resume_session
 * command. Untyped on the wire (the daemon JSON.parses command args), so every
 * field is treated as unknown and coerced here. */
export interface ReparentCommandFacts {
  device_changed?: unknown;
  from_device?: unknown;
  cross_user?: unknown;
  from_user?: unknown;
  to_user?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * Build the notice for a session reparented onto THIS machine.
 *
 * Lives here rather than in the daemon so the mapping from "what the command
 * said" plus "what this machine found" to "what the agent is told" is testable
 * on its own — the daemon keeps only the call.
 */
export function reparentNotice(opts: {
  /** How this machine names itself, matching the device chip the user sees. */
  destinationLabel: string;
  /** The source machine's path, from the command — only a hint about where it ran. */
  priorCwd?: string;
  /** What this machine actually prepared to resume in. */
  checkout?: CheckoutFacts;
  /** Raw parsed resume_session args. */
  command: ReparentCommandFacts;
}): string | null {
  const newCwd = opts.checkout?.cwd ?? opts.priorCwd;
  if (!newCwd) return null;

  // A reparent from a server that predates these fields is still a machine move
  // by construction, so an absent device_changed means "changed".
  const machineChanged = opts.command.device_changed !== false;
  const crossUser = opts.command.cross_user === true;
  const fromDevice = str(opts.command.from_device);
  const movedPath = !!opts.priorCwd && opts.priorCwd !== newCwd;

  return reorientationNotice({
    destination: opts.destinationLabel,
    newCwd,
    oldCwd: movedPath
      ? fromDevice
        ? `${opts.priorCwd} on ${fromDevice}`
        : opts.priorCwd
      : undefined,
    machineChanged,
    checkout: opts.checkout,
    account: crossUser
      ? { fromUser: str(opts.command.from_user), toUser: str(opts.command.to_user) }
      : undefined,
  });
}
