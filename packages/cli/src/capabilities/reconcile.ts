// The reconciler: one bounded pass from desired state to disk.
//
// Called from the daemon's heartbeat path, so its cost model is the design:
//
//   mode `off`               one field read, return
//   revisions equal          one integer compare, return
//   otherwise                LIVE scopes only, inside a millisecond budget
//
// "Live" means the user scope plus the project scopes of recently active
// conversations — never every enumerated root. projectRoots caps enumeration
// at 300 and walks one level deep (it never sees worktrees), so "all roots"
// is both expensive AND incomplete; the active-conversation set is small and
// is exactly where a wrong capability would bite next.

import { reconcileNeeded, convergenceState, markRevisionApplied } from "./heartbeat.js";
import { withLock } from "./lock.js";
import { runMigrations } from "./migrations.js";
import { plan, apply, type DesiredFile, type DriverLedger, type PlannedOp } from "./driver.js";

export interface ReconcileDeps {
  /** The HOME everything below operates on. REQUIRED, never defaulted: a test
   *  that exercised this module once ran the layout migration against the real
   *  home directory because a lower layer defaulted to os.homedir(). Explicit
   *  is the fix — the daemon passes the real home, tests pass a tmp dir, and
   *  nothing in this call tree guesses. */
  home: string;
  /** The resolved desired files for one live scope set. Injected: resolving
   *  needs bindings + consents from the server, and this module must stay
   *  callable from tests without a network. */
  desiredFiles: () => DesiredFile[];
  readLedger: () => DriverLedger;
  writeLedger: (ledger: DriverLedger) => void;
  /** The root the writer lock covers. */
  lockRoot: string;
  log?: (line: string) => void;
}

export interface ReconcileOutcome {
  ran: boolean;
  mode: string;
  skipped?: "mode_off" | "revision_current" | "lock_busy" | "budget_exceeded";
  planned?: number;
  wrote?: number;
  conflicts?: number;
  elapsedMs?: number;
}

/** The soft budget. Blown budgets finish the current op and stop planning
 *  more — a heartbeat path must never own the CPU for a human-visible beat. */
export const RECONCILE_BUDGET_MS = 150;

export function reconcileOnce(deps: ReconcileDeps, now: () => number = Date.now): ReconcileOutcome {
  const gate = reconcileNeeded();
  if (gate.mode === "off") return { ran: false, mode: "off", skipped: "mode_off" };
  if (!gate.behind) return { ran: false, mode: gate.mode, skipped: "revision_current" };

  const started = now();
  const locked = withLock(deps.lockRoot, () => {
    // Layout migrations run FIRST, under the same lock: planning against a
    // half-migrated layout would read the old paths as drift.
    runMigrations(deps.home, deps.log ?? (() => {}));

    const desired = deps.desiredFiles();
    const ledger = deps.readLedger();
    const ops = plan(desired, ledger, { home: deps.home });

    if (now() - started > RECONCILE_BUDGET_MS) {
      // Planning alone blew the budget: report and do nothing. The next beat
      // retries; a slow disk must not turn the heartbeat into the writer.
      return { budgetExceeded: true as const, ops };
    }

    if (gate.mode === "dry") {
      // Dry mode plans and reports, never applies — the kill switch's middle
      // position, and the default until the zero-ops gate is proven.
      return { dry: true as const, ops };
    }

    const outcome = apply(ops, ledger);
    deps.writeLedger(outcome.ledger);
    return { applied: true as const, ops, outcome };
  }, deps.log);

  const elapsedMs = now() - started;
  if (!locked.ok) return { ran: false, mode: gate.mode, skipped: "lock_busy", elapsedMs };

  const value = locked.value;
  const conflicts = value.ops.filter((op: PlannedOp) => op.op === "conflict").length;
  const line = (extra: string) =>
    deps.log?.(
      `[perf] capability reconcile mode=${gate.mode} planned=${value.ops.length} conflicts=${conflicts} ${extra} in ${elapsedMs}ms`,
    );

  if ("budgetExceeded" in value) {
    line("BUDGET-EXCEEDED (planned only, nothing written)");
    return { ran: true, mode: gate.mode, skipped: "budget_exceeded", planned: value.ops.length, conflicts, elapsedMs };
  }
  if ("dry" in value) {
    line("dry (nothing written)");
    return { ran: true, mode: gate.mode, planned: value.ops.length, wrote: 0, conflicts, elapsedMs };
  }

  // A clean, fully applied pass converges the revision; conflicts hold it
  // back so the fleet page keeps showing the machine as pending.
  if (conflicts === 0) markRevisionApplied(convergenceState().desired);
  line(`wrote=${value.outcome.wrote.length}`);
  return {
    ran: true,
    mode: gate.mode,
    planned: value.ops.length,
    wrote: value.outcome.wrote.length,
    conflicts,
    elapsedMs,
  };
}

/* ==========================================================================
 * The heartbeat entry point: fetch, resolve, apply builtins
 * ========================================================================== */

import { resolveCapabilities, type CapabilityBinding } from "@codecast/shared/contracts";
import { applyBuiltins } from "./builtinDriver.js";
import { deviceId } from "../remote/device.js";
import { currentProjectScopeKey } from "./equip.js";

export interface HeartbeatReconcileDeps {
  siteUrl: string;
  apiToken: string;
  userId: string;
  home: string;
  log: (line: string) => void;
  /** Injected for tests; the daemon passes fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * One reconcile from the daemon's heartbeat path.
 *
 * Order matters and is the lock module's rule: FETCH FIRST (bindings, over the
 * network), then lock, resolve and apply — never hold the lock across a
 * network call. Cost ladder as reconcileNeeded documents: mode off = one field
 * read; revisions equal = one compare; otherwise one bounded pass.
 *
 * Only builtins are materialized in this phase. Everything else resolves and
 * is reported, so a binding on mkt/… shows honestly as pending on the fleet
 * page rather than silently ignored.
 */
export async function reconcileFromHeartbeat(deps: HeartbeatReconcileDeps): Promise<ReconcileOutcome> {
  const gate = reconcileNeeded();
  if (gate.mode === "off") return { ran: false, mode: "off", skipped: "mode_off" };
  if (!gate.behind) return { ran: false, mode: gate.mode, skipped: "revision_current" };

  const started = Date.now();
  const f = deps.fetchImpl ?? fetch;
  let bindings: CapabilityBinding[] = [];
  try {
    const res = await f(`${deps.siteUrl}/cli/cap/bindings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: deps.apiToken }),
      signal: AbortSignal.timeout(10_000),
    });
    const rows: any[] = await res.json();
    if (!Array.isArray(rows)) throw new Error("bindings response was not a list");
    bindings = rows.map((r, i) => ({
      id: `${r.capability_slug}|${r.scope_kind}|${r.scope_key}|${i}`,
      userId: deps.userId,
      capabilitySlug: r.capability_slug,
      scopeKind: r.scope_kind,
      scopeKey: r.scope_key,
      enabled: !!r.enabled,
      updatedAt: typeof r.updated_at === "number" ? r.updated_at : 0,
    }));
  } catch (err) {
    deps.log(`[capabilities] reconcile skipped: could not fetch bindings (${String(err).slice(0, 100)})`);
    return { ran: false, mode: gate.mode, skipped: "lock_busy", elapsedMs: Date.now() - started };
  }

  const projectKey = currentProjectScopeKey(deps.userId, deps.home);
  const state = resolveCapabilities(bindings, {
    userId: deps.userId,
    deviceId: deviceId(),
    projectKeys: projectKey ? [projectKey] : [],
    client: "claude",
  });

  const locked = withLock(deps.home, () => applyBuiltins(state, gate.mode === "dry"), deps.log);
  const elapsedMs = Date.now() - started;
  if (!locked.ok) return { ran: false, mode: gate.mode, skipped: "lock_busy", elapsedMs };

  const o = locked.value;
  const touched = o.installed.length + o.refreshed.length + o.removed.length;
  deps.log(
    `[perf] capability reconcile mode=${gate.mode} bindings=${bindings.length} resolved=${state.entries.length} builtins installed=${o.installed.length} refreshed=${o.refreshed.length} removed=${o.removed.length}${o.unknown.length ? ` unknown=${o.unknown.join(",")}` : ""} in ${elapsedMs}ms${gate.mode === "dry" ? " (dry, nothing written)" : ""}`,
  );
  if (gate.mode === "on") markRevisionApplied(convergenceState().desired);
  return { ran: true, mode: gate.mode, planned: touched, wrote: gate.mode === "dry" ? 0 : touched, conflicts: 0, elapsedMs };
}
