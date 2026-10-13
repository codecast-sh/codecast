import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  recordConvergenceSignals,
  resetConvergenceState,
  convergenceState,
} from "./heartbeat.js";
import { reconcileOnce, RECONCILE_BUDGET_MS, type ReconcileDeps } from "./reconcile.js";

const dirs: string[] = [];
function root(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cc-rec-"));
  dirs.push(d);
  return d;
}
beforeEach(() => resetConvergenceState());
afterEach(() => {
  resetConvergenceState();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
  let ledger = { files: {} };
  return {
    home: root(),
    desiredFiles: () => [],
    readLedger: () => ledger,
    writeLedger: (l) => {
      ledger = l;
    },
    lockRoot: root(),
    log: () => {},
    ...over,
  };
}

describe("reconcileOnce — the cost ladder", () => {
  test("mode off: one field read, nothing else happens", () => {
    recordConvergenceSignals({ capabilities_mode: "off", capability_desired_revision: 5 });
    let touched = false;
    const out = reconcileOnce(deps({ desiredFiles: () => ((touched = true), []) }));
    expect(out).toMatchObject({ ran: false, skipped: "mode_off" });
    expect(touched).toBe(false);
  });

  test("revisions equal: one integer compare, nothing else happens", () => {
    recordConvergenceSignals({ capabilities_mode: "on", capability_desired_revision: 0 });
    let touched = false;
    const out = reconcileOnce(deps({ desiredFiles: () => ((touched = true), []) }));
    expect(out).toMatchObject({ ran: false, skipped: "revision_current" });
    expect(touched).toBe(false);
  });

  test("dry mode plans, reports, and writes NOTHING", () => {
    recordConvergenceSignals({ capabilities_mode: "dry", capability_desired_revision: 3 });
    const home = root();
    const out = reconcileOnce(
      deps({
        home,
        desiredFiles: () => [
          { slug: "builtin/x", relPath: ".claude/skills/x/SKILL.md", content: "body\n" },
        ],
        lockRoot: home,
      }),
    );
    expect(out).toMatchObject({ ran: true, mode: "dry", wrote: 0 });
    expect(out.planned).toBeGreaterThanOrEqual(1);
    // Dry did not converge the revision: the machine stays honestly pending.
    expect(convergenceState().applied).toBe(0);
  });

  test("a blown budget finishes planning and refuses to write", () => {
    recordConvergenceSignals({ capabilities_mode: "on", capability_desired_revision: 3 });
    let t = 0;
    const clock = () => {
      t += RECONCILE_BUDGET_MS + 1; // every observation of the clock is over budget
      return t;
    };
    const out = reconcileOnce(deps(), clock);
    expect(out.skipped).toBe("budget_exceeded");
  });

  test("a clean ON pass converges the revision; the next beat is free", () => {
    recordConvergenceSignals({ capabilities_mode: "on", capability_desired_revision: 4 });
    const first = reconcileOnce(deps());
    expect(first).toMatchObject({ ran: true, conflicts: 0 });
    expect(convergenceState().applied).toBe(4);
    const second = reconcileOnce(deps());
    expect(second).toMatchObject({ ran: false, skipped: "revision_current" });
  });

  test("conflicts hold the revision back — the fleet keeps showing pending", () => {
    recordConvergenceSignals({ capabilities_mode: "on", capability_desired_revision: 7 });
    const out = reconcileOnce(
      deps({
        desiredFiles: () => [
          // A path outside every allowed root is a planned conflict.
          { slug: "mkt/evil/x", relPath: ".ssh/authorized_keys", content: "nope" },
        ],
      }),
    );
    expect(out.conflicts).toBe(1);
    expect(convergenceState().applied).toBe(0);
  });
});
