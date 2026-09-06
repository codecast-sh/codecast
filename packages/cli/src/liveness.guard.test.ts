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
import { livenessFromTmuxState, shouldMarkSessionCompleted } from "./daemon.js";

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
