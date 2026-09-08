/**
 * `cast computer setup`: the grant flow for a machine with no desktop app.
 *
 * Before this, an ungranted Mac learned about the two permissions one failure
 * at a time: run a verb, read `permission_denied`, read its recovery, run
 * `permissions`, read `not-granted`, and only then find the flag that opens the
 * pane. Every step of that is the CLI telling a human what it could have shown
 * them. This verb is the whole path in one command: materialize the helper,
 * read both grants silently, say what each missing one allows and why the
 * helper holds it, ask, open the pane, wait for the grant to land, and report
 * what is true at the end.
 *
 * Two rules shape it, and both come from the focus policy (design 11.2, 13).
 *
 * **Nothing appears on screen before the human says so.** The read is the
 * silent probe `cast computer permissions` uses, so a machine that is already
 * granted goes through this verb without a window moving. The only raise is
 * `openPermissionSettings`, and it sits behind the confirm: a terminal answers
 * `y`, a script passes `--yes`, and a run with neither refuses to raise rather
 * than taking a screen nobody is watching.
 *
 * **It is idempotent.** A granted machine prints the state and exits 0. A
 * half granted one opens only the pane that is missing. Running it twice costs
 * one silent read.
 */

import type { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { ComputerError } from "./errors.js";
import type { ComputerPermissionApi } from "./run.js";
import type { ComputerPermissionId, ComputerPermissionStatusResult } from "./types.js";

/** Between two silent reads while waiting for a grant. The read itself costs a
 *  helper launch (2 to 3 seconds, design 13), so the gap only has to keep the
 *  loop from spinning. */
const POLL_INTERVAL_MS = 1_000;

/**
 * How long the wait runs before it gives up.
 *
 * The human's own exit is Ctrl C, and a terminal never reaches this. The
 * ceiling is for the other caller: `--yes` in a script, where nobody is at the
 * keyboard to grant anything and a wait with no end would hang the run.
 */
const POLL_TIMEOUT_MS = 5 * 60_000;

const LABEL: Record<ComputerPermissionId, string> = {
  accessibility: "Accessibility",
  screenshots: "Screen Recording",
};

/**
 * What each grant allows, and why it goes to the helper.
 *
 * The second half is the part a human cannot look up. macOS attaches a
 * permission to the program that asks for it, so the answer to "why is this
 * app I have never heard of asking" is the whole reason the helper exists.
 */
const EXPLANATION: Record<ComputerPermissionId, string> = {
  accessibility:
    "Accessibility lets the helper read the window you name and act inside it: list what the window holds, then click, scroll, or write a value into one item. Every verb needs it. The permission goes to the helper and not to your terminal, because macOS attaches it to the program that asks. Your terminal runs everything you and every agent type there, so a grant to it would reach all of that. The helper answers one command at a time, codecast signs it, and it holds nothing else.",
  screenshots:
    "Screen Recording lets the helper take a picture of the window it just read, so an image comes back beside the text. The text works without it and only the picture fails. It goes to the same helper, for the same reason: a grant to your terminal would let anything you run there record your screen, and a grant to the codecast app would put it on a program that stays open all day.",
};

export interface ComputerSetupDeps {
  permissions: ComputerPermissionApi;
  /** Puts the helper at its fixed path and answers with that path. */
  materialize: () => Promise<string>;
  /** Asks the human, on a terminal. Only reached when stdin is a tty. */
  confirm: (question: string) => Promise<boolean>;
  isTty: () => boolean;
  wait: (ms: number) => Promise<void>;
  /** Registers a Ctrl C handler and answers with the way to remove it. */
  onCancel: (fn: () => void) => () => void;
  log?: (line: string) => void;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

function missingIds(status: ComputerPermissionStatusResult): ComputerPermissionId[] {
  return status.permissions.filter((p) => p.status !== "granted").map((p) => p.id);
}

function list(ids: ComputerPermissionId[]): string {
  const names = ids.map((id) => LABEL[id]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}

/**
 * Run the flow. Returns when the grants are in place, when the human stops, or
 * when there was nobody to ask; throws only when the helper itself cannot be
 * put on the machine, which the caller renders as any other computer error.
 */
export async function runComputerSetup(opts: { yes?: boolean }, deps: ComputerSetupDeps): Promise<void> {
  const out = deps.log ?? ((line: string) => console.log(line));
  // Tracked so the closing report is separated from what came before it,
  // without opening on a blank line on a granted machine or doubling the gap
  // the confirm already left.
  let last: string | null = null;
  const say = (line: string) => {
    last = line;
    out(line);
  };
  const appPath = await deps.materialize();

  let status = await deps.permissions.readPermissionStatus();
  if (status.helperUnavailableReason) {
    // The helper was just materialized, so a read that still cannot see it is
    // a real fault rather than a missing setup step.
    throw new ComputerError("accessibility_error", status.helperUnavailableReason);
  }
  if (status.permissions.some((p) => p.status === "unsupported")) {
    throw new ComputerError("unsupported_capability", `cast computer runs on macOS only; this is ${status.platform}`);
  }

  const report = (verdict: string) => {
    if (last !== null && last !== "") say("");
    for (const line of deps.permissions.formatPermissionsReport(status)) say(line);
    say(verdict);
  };

  let missing = missingIds(status);
  if (!missing.length) return report("cast computer is ready. Both permissions were already granted.");

  say("Setting up cast computer.");
  say("");
  say(`Two macOS permissions make this work, and they go to the codecast computer helper, a small signed app at ${appPath}.`);
  for (const id of missing) {
    say("");
    say(EXPLANATION[id]);
  }
  say("");

  if (!(await allowed(missing, opts, deps, say))) {
    return report(`Nothing was opened. Run \`cast computer setup\` when you are ready to grant ${list(missing)}.`);
  }

  let cancelled = false;
  const release = deps.onCancel(() => {
    cancelled = true;
  });
  const opened = new Set<ComputerPermissionId>();
  const deadline = Date.now() + (deps.pollTimeoutMs ?? POLL_TIMEOUT_MS);
  try {
    while (!cancelled && missing.length) {
      const target = missing[0]!;
      if (!opened.has(target)) {
        opened.add(target);
        say(`Opening the ${LABEL[target]} pane. Grant it to "codecast computer" there.`);
        say("  Waiting for the grant. Ctrl C stops the wait and keeps what you have already granted.");
        // The one raise in this verb, and it runs only past the confirm above.
        await deps.permissions.openPermissionSettings(target);
      }
      if (Date.now() >= deadline) {
        say(`Stopped waiting for ${LABEL[target]}.`);
        break;
      }
      await deps.wait(deps.pollIntervalMs ?? POLL_INTERVAL_MS);
      if (cancelled) break;
      status = await deps.permissions.readPermissionStatus();
      const now = missingIds(status);
      for (const id of missing) if (!now.includes(id)) say(`${LABEL[id]} granted.`);
      missing = now;
    }
  } finally {
    release();
  }

  if (cancelled) say("Stopped.");
  return report(
    missing.length
      ? `Still missing: ${list(missing)}. Run \`cast computer setup\` again to open the pane once more.`
      : "cast computer is ready. Try `cast computer list-apps`.",
  );
}

/**
 * The confirm, and the one case that answers for the human: a run with no
 * terminal and no `--yes` refuses to raise. A window on a screen nobody is
 * watching is the failure this verb exists to avoid, and it cannot be undone by
 * anything the run does afterwards.
 */
async function allowed(
  missing: ComputerPermissionId[],
  opts: { yes?: boolean },
  deps: ComputerSetupDeps,
  say: (line: string) => void,
): Promise<boolean> {
  if (opts.yes) return true;
  if (!deps.isTty()) {
    say("This is not a terminal, so there is nobody here to confirm, and nothing will be opened.");
    say("Run `cast computer setup` in a terminal, or pass --yes to open the panes without asking.");
    return false;
  }
  return await deps.confirm(`Open System Settings so you can grant ${list(missing)}? [y/N] `);
}

/**
 * What the flow talks to when it is not a test: the real materialization, a
 * readline prompt, the real clock, and the real Ctrl C.
 */
export function defaultSetupDeps(permissions: ComputerPermissionApi, isTty: () => boolean): ComputerSetupDeps {
  return {
    permissions,
    materialize: async () => {
      // Dynamic, like every other heavy edge of this feature: the embedded
      // helper payload is megabytes, and no other verb should carry it.
      const [{ materializeHelperApp, withPrepareLock }, { getVersion }] = await Promise.all([
        import("./helperApp.js"),
        import("../update.js"),
      ]);
      // The swap and every helper launch share prepare.lock, so no concurrent
      // `cast computer` can see the fixed path half populated.
      const result = await withPrepareLock(() => materializeHelperApp({ version: getVersion() }));
      return result.appPath;
    },
    confirm: askYesNo,
    isTty,
    wait: (ms) => sleep(ms) as Promise<void>,
    onCancel: (fn) => {
      // Through the plain emitter surface: `process.removeListener` is typed
      // per event name, and its overload set has no "SIGINT" entry.
      const signals: EventEmitter = process;
      const listener = () => fn();
      signals.on("SIGINT", listener);
      return () => void signals.removeListener("SIGINT", listener);
    },
  };
}

/** A `[y/N]` prompt. Ctrl C at the prompt reads as no, which is also what the
 *  default reads as: this verb never opens a window on silence. */
async function askYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const iface = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      iface.on("SIGINT", () => resolve(""));
      iface.question(question, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    iface.close();
  }
}
