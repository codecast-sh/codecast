// `unverifiable` must never buy a teardown.
//
// The daemon has three answers to "is this agent still there?" — live,
// unverifiable, exited (@codecast/shared/contracts, liveness.ts) — and only
// `exited` may authorize a kill, a reap, a pane rebuild or a "completed" stamp.
// The failure this prevents is the oldest one in the file: a tmux probe times
// out, a `ps` read breaks, a machine stops answering, and code that treats
// "could not ask" as "gone" tears down a live session. That reaped idle-but-live
// sessions into `completed` and stranded the web UI until a reload
// (daemon.watchdog-completed-liveness.test.ts is the regression for that one).
//
// Two rules, both mechanical:
//
//  1. Nothing outside the vocabulary's own file compares against the verdict
//     literals. `authorizesTeardown(v)` is the one sanctioned gate, so a new
//     `=== "exited"` or `!== "live"` can never quietly decide a teardown.
//  2. A teardown verb gated on a liveness verdict is gated through
//     `authorizesTeardown`, never on the raw verdict.
//
// When this fails on your code, ask `authorizesTeardown` instead of comparing.
// Do not widen the allowlist: an entry needs a reason the comparison is not a
// teardown decision, and a stale entry (a file that no longer compares) fails
// the guard too. ct-49557.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codeLines } from "./test-helpers/sourceRegion.js";
import {
  LIVENESS_VERDICTS,
  authorizesTeardown,
  confineToOwningDevice,
} from "@codecast/shared/contracts";
import {
  livenessFromTmuxState,
  shouldMarkSessionCompleted,
  staleSessionVerdictFromProbe,
} from "./daemon.js";
// The managed browser's readers, held to the same rule below (ct-49625).
import { BrowserNotLive, isReachable, livenessProblem } from "./browser/recovery.js";
import type { InstanceState } from "./browser/instance.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [HERE, path.resolve(HERE, "../../shared/contracts")];

/** Functions whose result IS a LivenessVerdict. */
const VERDICT_PRODUCERS = [
  "panePresenceVerdict(",
  "paneRouteVerdict(",
  "staleSessionLivenessVerdict(",
  "livenessFromTmuxState(",
  "sessionLivenessVerdict(",
  "confineToOwningDevice(",
  "verdictFromProbe(",
  "probeLiveness(",
];

/** Teardown: everything that ends a session, a process or a pane. */
const TEARDOWN_VERBS = [
  "markSessionCompleted(",
  "reapOrphanedAgent(",
  "reapPidTree(",
  "killProcessTree(",
  "kill-session",
  "DEAD_PANE_ERROR",
];

/** Files allowed to compare verdict literals, each with the reason. */
const ALLOWED_COMPARISON: Record<string, string> = {
  "contracts/liveness.ts": "defines the vocabulary; authorizesTeardown and confineToOwningDevice are the comparisons everyone else reuses",
  "index.ts": "`cast accounts verify` grades a stored credential with its own ProfileAudit verdict, which borrows the word `unverifiable` and decides nothing about a process",
};

const SKIP_DIRS = new Set(["node_modules", "dist", "__fixtures__", "test-helpers"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

function sources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      // Shared contracts keep their directory so the two roots never collide.
      const rel = root === HERE
        ? path.relative(HERE, file)
        : path.join("contracts", path.relative(root, file));
      out.push({ rel, text: fs.readFileSync(file, "utf8") });
    }
  }
  return out;
}

// A comparison against one of the three verdict words. Written against the
// literals rather than the type because a guard reads source, not types.
const COMPARISON = new RegExp(
  `(?:[!=]==?\\s*"(?:${LIVENESS_VERDICTS.join("|")})")|(?:"(?:${LIVENESS_VERDICTS.join("|")})"\\s*[!=]==?)`,
);

describe("liveness verdicts are only ever read through authorizesTeardown", () => {
  const offenders: string[] = [];
  const seenAllowed = new Set<string>();

  for (const { rel, text } of sources()) {
    for (const { line, n } of codeLines(text)) {
      // TmuxLiveState shares the words "exited" and "unknown" with the verdict
      // vocabulary, so only a line that also handles a VERDICT is in scope.
      const producer = VERDICT_PRODUCERS.find((p) => line.includes(p));
      const comparesVerdict = COMPARISON.test(line) && (producer !== undefined || line.includes("unverifiable"));
      if (!comparesVerdict) continue;
      if (rel in ALLOWED_COMPARISON) {
        seenAllowed.add(rel);
        continue;
      }
      offenders.push(`${rel}:${n} compares a liveness verdict instead of asking authorizesTeardown`);
    }
  }

  test("no file branches on the verdict literals", () => {
    expect(offenders).toEqual([]);
  });

  test("every allowlist entry still earns its place", () => {
    expect([...Object.keys(ALLOWED_COMPARISON)].filter((f) => !seenAllowed.has(f))).toEqual([]);
  });
});

describe("a teardown gated on liveness goes through authorizesTeardown", () => {
  const offenders: string[] = [];

  for (const { rel, text } of sources()) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!TEARDOWN_VERBS.some((verb) => line.includes(verb))) return;
      // The gate is on this line or in the few lines above it (an `if`, a
      // ternary, a guard clause that fell through to the verb).
      const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
      if (!VERDICT_PRODUCERS.some((p) => window.includes(p))) return;
      if (window.includes("authorizesTeardown(")) return;
      offenders.push(`${rel}:${i + 1} tears down on a raw liveness verdict`);
    });
  }

  test("no teardown reads the verdict directly", () => {
    expect(offenders).toEqual([]);
  });
});

describe("the migrated gates answer safely for every verdict", () => {
  test("only exited authorizes a teardown", () => {
    expect(LIVENESS_VERDICTS.filter(authorizesTeardown)).toEqual(["exited"]);
  });

  test("an unrecognized pane is unverifiable, and reaps nothing", () => {
    expect(livenessFromTmuxState("unknown")).toBe("unverifiable");
    expect(authorizesTeardown(livenessFromTmuxState("unknown"))).toBe(false);
    expect(authorizesTeardown(livenessFromTmuxState("exited"))).toBe(true);
  });

  test("the stale-status watchdog never completes a session it could not verify", () => {
    // Below the threshold nothing is established, so nothing is marked done.
    expect(shouldMarkSessionCompleted({ status: "idle", ageMs: 60_000, hasLiveAgentProcess: false })).toBe(false);
    // Past it, only this device's own process table may say so.
    expect(shouldMarkSessionCompleted({ status: "idle", ageMs: 60 * 60_000, hasLiveAgentProcess: false })).toBe(true);
    expect(authorizesTeardown(confineToOwningDevice("exited", false))).toBe(false);
  });
});

// The boolean above cannot tell "the process table answered, nothing there" from
// "the question could not be asked", and the watchdog reaps on the first. So the
// watchdog takes the PROBE, not its boolean: a `ps` that throws leaves the
// session alone until the next sweep instead of stamping it completed.
describe("a failed process probe never completes a session", () => {
  const STALE = { status: "idle" as const, ageMs: 60 * 60_000 };

  test("a probe that throws is unverifiable, and reaps nothing", async () => {
    const verdict = await staleSessionVerdictFromProbe(STALE, async () => {
      throw new Error("ps: command failed");
    });
    expect(verdict).toBe("unverifiable");
    expect(authorizesTeardown(verdict)).toBe(false);
  });

  test("a probe that answers 'nothing there' still reaps", async () => {
    const verdict = await staleSessionVerdictFromProbe(STALE, async () => null);
    expect(verdict).toBe("exited");
    expect(authorizesTeardown(verdict)).toBe(true);
  });

  test("a probe that finds the agent keeps the session", async () => {
    const verdict = await staleSessionVerdictFromProbe(STALE, async () => ({ pid: 42 }));
    expect(verdict).toBe("live");
    expect(authorizesTeardown(verdict)).toBe(false);
  });

  test("a throw and an empty answer are not the same verdict", async () => {
    const thrown = await staleSessionVerdictFromProbe(STALE, async () => { throw new Error("boom"); });
    const empty = await staleSessionVerdictFromProbe(STALE, async () => null);
    expect(thrown).not.toBe(empty);
  });
});

// ---------------------------------------------------------------------------
// The managed browser, held to the same rule (ct-49625).
//
// `cast browser` learned this lesson first and on its own: one short CDP probe
// timed out under load, every agent read it as a dead browser, and each ran the
// recovery the CLI named — stop/start — killing the browser under all the
// others (the 2026-08-14 stampede). It carried its own three words for years.
// They are the daemon's words now, so the rules below are the daemon's rules
// pointed at packages/cli/src/browser.
//
// The browser gets a stricter form than the tree-wide rule above. Every file
// there reads a verdict through exactly two functions — `isReachable` to
// proceed, `authorizesTeardown` to relaunch — so ANY comparison against a
// verdict word is an offender, whatever else is on the line. That is what keeps
// a silent browser out of the branch that launches over it.

const BROWSER_DIR = "browser" + path.sep;

/** Ends or replaces the machine's one Chrome. */
const BROWSER_RELAUNCH_VERBS = ["launchManagedChrome(", "startLocalBrowser(", "killStrayChrome(", "stopInstance("];

/** Browser files allowed to name a verdict word, with the reason. */
const BROWSER_ALLOWED_COMPARISON: Record<string, string> = {
  "browser/recovery.ts": "defines `isReachable`, the positive-contact gate the rest of the browser reads verdicts through; it authorizes nothing",
};

/** A comparison against any verdict word, with nothing else required of the line. */
const BARE_COMPARISON = new RegExp(
  `(?:[!=]==?\\s*"(?:${LIVENESS_VERDICTS.join("|")})")|(?:"(?:${LIVENESS_VERDICTS.join("|")})"\\s*[!=]==?)`,
);

function browserSources(): Array<{ rel: string; text: string }> {
  return sources().filter((f) => f.rel.startsWith(BROWSER_DIR));
}

describe("the browser reads verdicts only through isReachable and authorizesTeardown", () => {
  const offenders: string[] = [];
  const seenAllowed = new Set<string>();

  for (const { rel, text } of browserSources()) {
    for (const { line, n } of codeLines(text)) {
      if (!BARE_COMPARISON.test(line)) continue;
      if (rel in BROWSER_ALLOWED_COMPARISON) {
        seenAllowed.add(rel);
        continue;
      }
      offenders.push(`${rel}:${n} names a liveness verdict; ask isReachable or authorizesTeardown`);
    }
  }

  test("no browser file compares a verdict word", () => {
    expect(offenders).toEqual([]);
  });

  test("every browser allowlist entry still earns its place", () => {
    expect(Object.keys(BROWSER_ALLOWED_COMPARISON).filter((f) => !seenAllowed.has(f))).toEqual([]);
  });

  test("the browser still has files in scope", () => {
    // A rename that moved the directory would otherwise pass by checking nothing.
    expect(browserSources().length).toBeGreaterThan(10);
  });
});

// Stopping or replacing the shared Chrome is a teardown like any other, and the
// gate is far from the verb here: `startLocalBrowser` probes at the top and
// launches sixty lines later, past the profile clone. So the rule is per FILE —
// a file that both reads a verdict and can end the browser must ask.
describe("a file that can replace the browser asks authorizesTeardown", () => {
  const offenders: string[] = [];

  for (const { rel, text } of browserSources()) {
    const producesVerdict = VERDICT_PRODUCERS.some((p) => text.includes(p));
    const calls = BROWSER_RELAUNCH_VERBS.filter((verb) =>
      codeLines(text).some(({ line }) => line.includes(verb) && !line.includes(`function ${verb}`)),
    );
    if (!producesVerdict || calls.length === 0) continue;
    if (text.includes("authorizesTeardown(")) continue;
    offenders.push(`${rel} calls ${calls.join(", ")} on a liveness verdict without authorizesTeardown`);
  }

  test("no browser file relaunches on an unasked verdict", () => {
    expect(offenders).toEqual([]);
  });

  test("the files that do relaunch are still covered", () => {
    const covered = browserSources()
      .filter((f) => VERDICT_PRODUCERS.some((p) => f.text.includes(p)))
      .filter((f) => BROWSER_RELAUNCH_VERBS.some((verb) => f.text.includes(verb)))
      .map((f) => f.rel);
    expect(covered).toContain("browser/managedBrowser.ts");
    expect(covered).toContain("browser/cli.ts");
  });
});

// The behaviour the words carry, unchanged by the rename: an overloaded browser
// is told to wait, a gone one is told to start.
describe("the browser's guidance follows the verdict", () => {
  const state = { pid: 4242 } as InstanceState;

  test("only an exited browser authorizes the relaunch", () => {
    expect(LIVENESS_VERDICTS.filter(authorizesTeardown)).toEqual(["exited"]);
    expect(LIVENESS_VERDICTS.filter(isReachable)).toEqual(["live"]);
  });

  test("a browser that did not answer says wait, and never stop/start", () => {
    const problem = livenessProblem("unverifiable", state)!;
    expect(problem.message).toMatch(/not answering CDP/);
    expect(problem.hint).toMatch(/Do not stop\/start/);
    expect(authorizesTeardown("unverifiable")).toBe(false);
  });

  test("a browser observed gone says start one", () => {
    const problem = livenessProblem("exited", state)!;
    expect(problem.message).toMatch(/no managed browser is running/);
    expect(problem.hint).toMatch(/cast browser start/);
  });

  test("a reachable browser has no problem to report", () => {
    expect(livenessProblem("live", state)).toBeNull();
  });

  test("the error the CLI catches carries the verdict, not a boolean", () => {
    expect(authorizesTeardown(new BrowserNotLive("unverifiable", null).liveness)).toBe(false);
    expect(authorizesTeardown(new BrowserNotLive("exited", null).liveness)).toBe(true);
  });
});
