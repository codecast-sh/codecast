// `cast computer` drives native apps, so the browser guard next door cannot
// protect the human here: it scans for CDP raise calls, and this feature sends
// none — it raises through the accessibility API inside the helper. The
// discipline has to live in the command instead, and this is what holds it.
//
// The rule (design ct-49518 section 11.2): no verb raises a window unless the
// caller asked for that raise by name. Two flags do: `--restore-window`, and
// `permissions --open-settings`, which puts the System Settings pane and the
// helper's setup window on screen. Both stamp the focus sentinel's
// deliberate-raise path so a raise of the agent's own Chrome is not bounced a
// second later. Any other file that sets `restoreWindow` on a helper request,
// or launches the settings window, is an unstamped, unasked-for front switch —
// the failure our focus memories exist to prevent.
//
// `setup` opens the same pane and is the one place where the ask is a question
// rather than a flag, so the allowlist alone cannot describe it. The runs at
// the bottom of this file do: a human who declines, and a run with nobody to
// decline, both end with no window on screen.
//
// `permissions` with no flag is a status read and must stay silent: six error
// recoveries send an agent there to diagnose, and it used to take the screen
// on every one of them (ct-49667).
//
// When this fails on your code, drop the raise: set-value, a click on an
// element that advertises a press action, and perform-secondary-action all
// work on a background window and take nothing from the human. Do not widen
// the allowlist; an entry needs a reason the raise is the agent's explicit
// ask, and a stale entry (a file that no longer raises) fails the guard too.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codeLines } from "../test-helpers/sourceRegion.js";
import { NONE, setupHarness } from "../test-helpers/computerSetupHarness.js";
import { runComputerSetup, type ComputerSetupDeps } from "./setup.js";

const COMPUTER = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(COMPUTER, "..");

/**
 * What actually raises, in the two forms it can take: the request field the
 * helper acts on, and the declaration of the flag that produces it. Naming the
 * flag in prose is not a raise — the recovery table and the help text both have
 * to teach it, so a bare string match would fail on its own guidance.
 */
const RAISES: { what: string; re: RegExp }[] = [
  { what: "sets restoreWindow on a helper request", re: /\brestoreWindow\b/ },
  { what: "declares the --restore-window flag", re: /\.option\(\s*"--restore-window/ },
  { what: "launches the helper's System Settings window", re: /\bopenPermissionSettings\b/ },
  { what: "declares the --open-settings flag", re: /\.option\(\s*"--open-settings/ },
];

/** Files allowed to raise, each with the reason it is the agent's explicit ask. */
const ALLOWED: Record<string, string> = {
  "computer/cli.ts": "declares the two flags in the feature that may take the human's screen",
  "computer/run.ts": "routes those flags, and only those flags, to the raising call",
  "computer/client.ts": "stamps the deliberate raise before the request goes out, so the sentinel spares it",
  "computer/permissions.ts": "opens the settings window for --open-settings, stamped the same way",
  "computer/setup.ts": "opens each missing pane only past the confirm a human answered, or an explicit --yes",
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

describe("no cast computer verb raises a window over the human", () => {
  const offenders: string[] = [];
  const seenAllowed = new Set<string>();
  for (const file of walk(COMPUTER)) {
    const rel = path.relative(SRC, file);
    // codeLines drops comments and strings-only lines, so a mention in prose
    // (this feature is full of it) never counts as a raise.
    for (const { line, n } of codeLines(fs.readFileSync(file, "utf8"))) {
      const hit = RAISES.find((raise) => raise.re.test(line));
      if (!hit) continue;
      if (rel in ALLOWED) {
        seenAllowed.add(rel);
        continue;
      }
      offenders.push(`${rel}:${n} ${hit.what}`);
    }
  }

  test("every raise outside the allowlist is a focus steal", () => {
    expect(offenders).toEqual([]);
  });

  test("every allowlist entry still raises (no stale entries)", () => {
    expect(Object.keys(ALLOWED).filter((rel) => !seenAllowed.has(rel))).toEqual([]);
  });
});

/**
 * The allowlist can only say that a file is allowed to raise. `setup` is the
 * one file where the raise is conditional, so what matters is the condition,
 * and only a run can show it. Three ways in, and a window opens in exactly one
 * of them (ct-49790).
 */
describe("cast computer setup opens nothing until it is allowed to", () => {
  const opened = (calls: string[]) => calls.filter((c) => c.startsWith("open:"));

  test("a human who says no gets no window", async () => {
    const harness = setupHarness({ isTty: true, confirm: false, grants: [NONE] });
    await runComputerSetup({}, harness.deps as ComputerSetupDeps);
    expect(opened(harness.calls)).toEqual([]);
  });

  test("no terminal and no --yes gets no window, and is not even asked", async () => {
    const harness = setupHarness({ isTty: false, confirm: true, grants: [NONE] });
    await runComputerSetup({}, harness.deps as ComputerSetupDeps);
    expect(harness.calls).toEqual(["materialize", "read"]);
  });

  test("the raise comes after the answer, never before it", async () => {
    const harness = setupHarness({
      isTty: true,
      confirm: true,
      grants: [NONE, { accessibility: "granted", screenshots: "granted" }],
    });
    await runComputerSetup({}, harness.deps as ComputerSetupDeps);
    expect(harness.calls.indexOf("confirm")).toBeLessThan(harness.calls.indexOf("open:accessibility"));
  });
});
