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
 * The heartbeat entry point: fetch, resolve, apply builtins and the kit
 * ========================================================================== */

import { requiresExplicitConsent, resolveCapabilities, type CapabilityBinding, type DesiredState, type ExecutionSurface } from "@codecast/shared/contracts";
import { applyBuiltins } from "./builtinDriver.js";
import { deviceId as localDeviceId } from "../remote/device.js";
import { currentProjectScopeKey } from "./equip.js";
// The kit's modules load on the first pass that needs them, off the daemon's
// boot graph (bench/bootGraph.guard.test.ts).
import type { KitInstallItem } from "./kitInstall.js";
import type { InstructionFragment } from "./instructionFragments.js";
import type { ProjectWritesSetting } from "./projectWrites.js";

export interface HeartbeatReconcileDeps {
  siteUrl: string;
  apiToken: string;
  userId: string;
  home: string;
  log: (line: string) => void;
  /** Injected for tests; the daemon passes fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; the daemon's own id otherwise. */
  deviceId?: string;
  /** The device setting capabilities.project_writes. */
  projectWrites?: ProjectWritesSetting;
}

/** What this machine did with one kit slug, as reportKitApplied takes it. */
export interface KitAppliedItem {
  slug: string;
  hash: string;
  status: "installed" | "pending_consent" | "conflict" | "error";
  detail?: string;
}

/** Everything the kit pass needs from the network, gathered BEFORE the lock. */
export interface KitResolution {
  items: KitInstallItem[];
  fragments: InstructionFragment[];
  /** Enabled slugs not resolved this pass: their installs stay as they are. */
  hold: string[];
  report: KitAppliedItem[];
  /** Slugs whose owner chose the kit's copy over a conflicting file, for the
   *  exact version being installed. */
  adopt: Set<string>;
}

async function postJson(deps: HeartbeatReconcileDeps, route: string, body: Record<string, unknown>): Promise<any> {
  const res = await (deps.fetchImpl ?? fetch)(`${deps.siteUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: deps.apiToken, ...body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) throw new Error(`no ${route} route on this server`);
  const json = await res.json();
  if (json && typeof json === "object" && "error" in json && json.error) throw new Error(String(json.error));
  return json;
}

/** authored/<owner>/<kind>/<name> */
function parseKitSlug(slug: string): { owner: string; kind: string; name: string } | null {
  const parts = slug.split("/");
  if (parts.length !== 4 || parts[0] !== "authored") return null;
  return { owner: parts[1]!, kind: parts[2]!, name: parts[3]! };
}

/**
 * Fetch every enabled kit slug's current version, check consent, and put its
 * bytes in the store. Network only; nothing here takes the capability lock.
 * A failure holds the slug (its install stays) and is reported as an error;
 * an answer of "no such version you can read" is not a failure, so the slug
 * is simply absent from the desired set and its files go.
 */
export async function resolveKitEntries(state: DesiredState, deps: HeartbeatReconcileDeps): Promise<KitResolution> {
  const out: KitResolution = { items: [], fragments: [], hold: [], report: [], adopt: new Set() };
  const wanted = state.entries.filter((e) => e.slug.startsWith("authored/") && e.enabled && !e.withheld);
  if (wanted.length === 0) return out;
  const device = deps.deviceId ?? localDeviceId();

  let consents: Array<{ capability_slug: string; manifest_hash: string }> | undefined;
  const consented = async (slug: string, hash: string): Promise<boolean> => {
    if (!consents) {
      try {
        const rows = await postJson(deps, "/cli/cap/consents", { device_id: device });
        consents = Array.isArray(rows) ? rows : [];
      } catch (err) {
        deps.log(`[capabilities] could not read consents (${String(err).slice(0, 100)}); code-running kit items wait`);
        consents = [];
      }
    }
    return consents.some((c) => c.capability_slug === slug && c.manifest_hash === hash);
  };

  let teamNames: Map<string, string> | undefined;
  const teamName = async (owner: string, workspace: string | undefined): Promise<string> => {
    if (!workspace?.startsWith("team:")) return "Personal";
    if (!teamNames) {
      teamNames = new Map();
      try {
        const res = await postJson(deps, "/cli/teams", {});
        for (const t of res?.teams ?? []) if (t?._id) teamNames.set(String(t._id), String(t.name ?? ""));
      } catch {
        // the id stands in for the name
      }
    }
    return teamNames.get(owner) || "Team";
  };

  for (const entry of wanted) {
    const parsed = parseKitSlug(entry.slug);
    if (!parsed) continue;
    const fail = (detail: string, hash = "unknown") => {
      out.hold.push(entry.slug);
      out.report.push({ slug: entry.slug, hash, status: "error", detail: detail.slice(0, 300) });
    };
    let version: any;
    try {
      version = await postJson(deps, "/cli/cap/kit/version", { slug: entry.slug });
    } catch (err) {
      fail(`could not fetch the version: ${String(err).slice(0, 200)}`);
      continue;
    }
    if (!version) {
      out.report.push({ slug: entry.slug, hash: "unknown", status: "error", detail: "no version you can read" });
      continue;
    }
    const hash = String(version.folder_hash ?? "");
    if (version.kind !== parsed.kind || version.name !== parsed.name || !/^[0-9a-f]{64}$/.test(hash)) {
      fail("the server's version does not match the slug", hash || "unknown");
      continue;
    }
    const surfaces = (Array.isArray(version.surfaces) ? version.surfaces : undefined) as ExecutionSurface[] | undefined;
    if (requiresExplicitConsent(surfaces) && !(await consented(entry.slug, hash))) {
      out.hold.push(entry.slug);
      out.report.push({ slug: entry.slug, hash, status: "pending_consent", detail: (surfaces ?? []).join(",") || "unclassified" });
      continue;
    }
    if (parsed.kind === "instructions") {
      out.fragments.push({ slug: entry.slug, teamName: await teamName(parsed.owner, version.workspace), name: parsed.name, body: String(version.main_body ?? ""), hash });
      continue;
    }
    if (parsed.kind !== "skill" && parsed.kind !== "command" && parsed.kind !== "subagent") continue;
    if (typeof version.download_url !== "string") {
      fail("the version has no download URL", hash);
      continue;
    }
    const { fetchIntoStore } = await import("./contentStore.js");
    const stored = await fetchIntoStore({ home: deps.home, hash, url: version.download_url, fetchImpl: deps.fetchImpl, log: deps.log });
    if (!stored.ok) {
      fail(`${stored.reason}: ${stored.detail}`, hash);
      continue;
    }
    out.items.push({ slug: entry.slug, kind: parsed.kind, name: parsed.name, hash, files: stored.files });
  }
  if (out.items.length > 0) {
    // "Use the kit's copy" on the web. Counts only for the hash it was
    // pressed on, so it never carries over to a later version. A missing
    // route or a failed read means no adoptions: conflicts stay conflicts.
    try {
      const rows = await postJson(deps, "/cli/cap/kit/adoptions", { device_id: device });
      for (const r of Array.isArray(rows) ? rows : []) {
        if (out.items.some((i) => i.slug === r?.slug && i.hash === r?.hash)) out.adopt.add(r.slug);
      }
    } catch (err) {
      deps.log(`[capabilities] could not read kit adoptions (${String(err).slice(0, 100)})`);
    }
  }
  return out;
}

/**
 * One reconcile from the daemon's heartbeat path.
 *
 * Order matters and is the lock module's rule: FETCH FIRST (bindings, kit
 * versions and their bytes, over the network), then lock, plan and apply —
 * never hold the lock across a network call. Cost ladder as reconcileNeeded
 * documents: mode off = one field read; revisions equal = one compare;
 * otherwise one bounded pass.
 *
 * Builtins become CLAUDE.md sections; kit skills, commands and subagents
 * become files through kitInstall; kit instruction fragments become owned
 * sections through instructionFragments. What happened to each kit slug is
 * reported to /cli/cap/kit/applied after the lock is released.
 */
export async function reconcileFromHeartbeat(deps: HeartbeatReconcileDeps): Promise<ReconcileOutcome> {
  const gate = reconcileNeeded();
  if (gate.mode === "off") return { ran: false, mode: "off", skipped: "mode_off" };
  if (!gate.behind) return { ran: false, mode: gate.mode, skipped: "revision_current" };
  const desiredRevision = convergenceState().desired;

  const started = Date.now();
  let bindings: CapabilityBinding[] = [];
  try {
    const rows: any[] = await postJson(deps, "/cli/cap/bindings", {});
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
    deviceId: deps.deviceId ?? localDeviceId(),
    projectKeys: projectKey ? [projectKey] : [],
    client: "claude",
  });

  const kit = await resolveKitEntries(state, deps);
  const dry = gate.mode === "dry";
  const { applyKit, planKit, readKitLedger, writeKitLedger } = await import("./kitInstall.js");
  const { applyInstructionFragments } = await import("./instructionFragments.js");

  const locked = withLock(deps.home, () => {
    const builtins = applyBuiltins(state, dry);
    const ledger = readKitLedger(deps.home);
    const kitOps = planKit(deps.home, kit.items, ledger, kit.hold, { adopt: kit.adopt });
    let kitWrote = 0;
    let kitRemoved = 0;
    let moved: Array<{ slug: string; from: string; to: string }> = [];
    let applyConflicts: Array<{ slug: string; reason: string; detail?: string }> = [];
    if (!dry) {
      const applied = applyKit(deps.home, kitOps, ledger);
      if (JSON.stringify(applied.ledger.files) !== JSON.stringify(ledger.files)) writeKitLedger(deps.home, applied.ledger);
      kitWrote = applied.wrote.length;
      kitRemoved = applied.removed.length;
      moved = applied.moved;
      applyConflicts = applied.conflicts.filter((c) => c.reason === "move_aside_failed");
    }
    const sections = applyInstructionFragments({
      home: deps.home,
      fragments: kit.fragments,
      hold: kit.hold,
      dryRun: dry,
      projectWrites: deps.projectWrites,
      log: deps.log,
    });
    return { builtins, kitOps, kitWrote, kitRemoved, moved, applyConflicts, sections };
  }, deps.log);
  const elapsedMs = Date.now() - started;
  if (!locked.ok) return { ran: false, mode: gate.mode, skipped: "lock_busy", elapsedMs };

  const { builtins: o, kitOps, kitWrote, kitRemoved, moved, applyConflicts, sections } = locked.value;
  const conflictsBySlug = new Map<string, string>();
  for (const op of [...kitOps, ...sections.ops, ...applyConflicts.map((c) => ({ op: "conflict" as const, ...c }))]) {
    if (op.op === "conflict" && !conflictsBySlug.has(op.slug)) conflictsBySlug.set(op.slug, `${op.reason}${op.detail ? `: ${op.detail}` : ""}`);
  }
  const homeRel = (p: string) => (p.startsWith(deps.home + "/") ? `~${p.slice(deps.home.length)}` : p);
  const movedDetail = (slug: string) => {
    const paths = moved.filter((m) => m.slug === slug).map((m) => homeRel(m.to));
    return paths.length ? { detail: `moved your copy to ${paths.join(", ")}` } : {};
  };
  const report: KitAppliedItem[] = [
    ...kit.report,
    ...[...kit.items, ...kit.fragments].map((i): KitAppliedItem => {
      const conflict = conflictsBySlug.get(i.slug);
      return conflict ? { slug: i.slug, hash: i.hash, status: "conflict", detail: conflict.slice(0, 300) } : { slug: i.slug, hash: i.hash, status: "installed", ...movedDetail(i.slug) };
    }),
  ];
  if (!dry) {
    try {
      await postJson(deps, "/cli/cap/kit/applied", { device_id: deps.deviceId ?? localDeviceId(), items: report });
    } catch (err) {
      deps.log(`[capabilities] could not report kit state (${String(err).slice(0, 100)})`);
    }
  }

  const touched = o.installed.length + o.refreshed.length + o.removed.length;
  const conflicts = conflictsBySlug.size;
  // Only a failure that held its slug is worth retrying; "no version you can
  // read" is an answer, and its files are already gone.
  const errors = kit.report.filter((r) => r.status === "error" && kit.hold.includes(r.slug)).length;
  const pending = kit.report.filter((r) => r.status === "pending_consent").length;
  deps.log(
    `[perf] capability reconcile mode=${gate.mode} bindings=${bindings.length} resolved=${state.entries.length} builtins installed=${o.installed.length} refreshed=${o.refreshed.length} removed=${o.removed.length}${o.unknown.length ? ` unknown=${o.unknown.join(",")}` : ""} kit items=${kit.items.length} fragments=${kit.fragments.length} planned=${kitOps.length} wrote=${kitWrote} removed=${kitRemoved} moved_aside=${moved.length} sections=${sections.wrote.length}/${sections.removed.length} pending_consent=${pending} conflicts=${conflicts} errors=${errors} in ${elapsedMs}ms${dry ? " (dry, nothing written)" : ""}`,
  );
  // Converged only when nothing is left to retry: a conflict or a failed fetch
  // keeps the machine behind so the next beat tries again. A pending consent
  // is converged; granting it bumps the revision.
  if (gate.mode === "on" && conflicts === 0 && errors === 0) markRevisionApplied(desiredRevision);
  const planned = touched + kitOps.length + sections.ops.length;
  return { ran: true, mode: gate.mode, planned, wrote: dry ? 0 : touched + kitWrote + kitRemoved + sections.wrote.length + sections.removed.length, conflicts, elapsedMs };
}
