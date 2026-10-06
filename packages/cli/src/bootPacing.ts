// Cautious boot: how hard the daemon may push at startup.
//
// After a stall or a crash the daemon restarts on a machine that is usually
// still saturated, and a normal boot kicks everything off at once (re-attach
// every pane, scan every session for prompts, sync every file, poll the
// scheduler). This module turns the trouble signals the daemon already has at
// boot (the hang marker left by the previous daemon, the crash counter, host
// load and memory pressure) into one pacing plan. Every bound main() applies
// at boot comes from the plan; the normal tier carries the historical
// constants, so a quiet boot behaves exactly as before. A missing or failed
// signal reads as "no trouble": the plan fails open to normal, never closed.

export type BootPacingTier = "normal" | "cautious" | "severe";

export interface BootPacingSignals {
  /** Age of the hang marker consumed at this boot (ms), or undefined when none. */
  hangAgeMs?: number;
  /** Crash counter in its 30 min window, or undefined when the file was absent. */
  crashCount?: number;
  /** The watchdog rule that killed the previous daemon, when it did. */
  watchdogRule?: string;
  /** 1 minute load average. */
  load1?: number;
  /** Logical cpu count. */
  cpuCount?: number;
  /** macOS memorystatus level; "unknown" elsewhere or when the probe failed. */
  memoryPressure?: "normal" | "elevated" | "critical" | "unknown";
}

export interface BootPacingPlan {
  tier: BootPacingTier;
  /** Bound on warm-restart pane re-attach (runBounded). */
  reattachConcurrency: number;
  /** Gap between the per-session prompt checks after a warm restart. */
  promptScanSpacingMs: number;
  /** Bound on the startup unsynced-file scan. */
  startupSyncConcurrency: number;
  /** Bound on the watchdog's stale-file sync. */
  watchdogSyncConcurrency: number;
  /** Delay before the trigger scheduler starts polling. */
  schedulerStartDelayMs: number;
  /** Multiplier on the staggered remote fan-out offsets. */
  fanoutOffsetScale: number;
  /** How long after boot the plan still binds work that repeats for the whole
   * daemon life (the watchdog sync, wake recovery sweeps). Past this the
   * machine has had its chance to settle and those bounds return to normal. */
  holdMs: number;
  /** One short line for the log and the heartbeat. */
  reason: string;
}

/** A hang or crash older than this is history, not a reason to go slow. */
export const BOOT_TROUBLE_WINDOW_MS = 60 * 60 * 1000;
/** load1 per cpu at or above this is pressure; at or above the second it is severe. */
export const BOOT_LOAD_RATIO_CAUTIOUS = 2;
export const BOOT_LOAD_RATIO_SEVERE = 6;

const PLAN_BY_TIER: Record<BootPacingTier, Omit<BootPacingPlan, "tier" | "reason">> = {
  // The numbers main() used before pacing existed. Changing one here changes a
  // quiet boot; the tiers below are the only place a troubled boot differs.
  normal: {
    reattachConcurrency: 8,
    promptScanSpacingMs: 0,
    startupSyncConcurrency: 4,
    watchdogSyncConcurrency: 20,
    schedulerStartDelayMs: 0,
    fanoutOffsetScale: 1,
    holdMs: 0,
  },
  cautious: {
    reattachConcurrency: 3,
    promptScanSpacingMs: 750,
    startupSyncConcurrency: 2,
    watchdogSyncConcurrency: 6,
    schedulerStartDelayMs: 60_000,
    fanoutOffsetScale: 2,
    holdMs: 15 * 60_000,
  },
  severe: {
    reattachConcurrency: 1,
    promptScanSpacingMs: 1_500,
    startupSyncConcurrency: 1,
    watchdogSyncConcurrency: 3,
    schedulerStartDelayMs: 180_000,
    fanoutOffsetScale: 3,
    holdMs: 30 * 60_000,
  },
};

function finite(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function planBootPacing(signals: BootPacingSignals): BootPacingPlan {
  const trouble: string[] = [];
  const hangAge = finite(signals.hangAgeMs);
  if (hangAge !== undefined && hangAge < BOOT_TROUBLE_WINDOW_MS) {
    trouble.push(
      signals.watchdogRule
        ? `watchdog killed the previous daemon ${Math.round(hangAge / 60_000)}m ago (${signals.watchdogRule})`
        : `hang ${Math.round(hangAge / 60_000)}m ago`,
    );
  }
  const crashes = finite(signals.crashCount);
  if (crashes !== undefined && crashes > 0) trouble.push(`${crashes} crash${crashes === 1 ? "" : "es"} in the last 30m`);

  const load1 = finite(signals.load1);
  const cpus = finite(signals.cpuCount);
  const ratio = load1 !== undefined && cpus !== undefined && cpus > 0 ? load1 / cpus : undefined;
  const loadText = ratio === undefined ? "" : `load ${load1!.toFixed(1)} on ${cpus} cpus`;
  const loadCautious = ratio !== undefined && ratio >= BOOT_LOAD_RATIO_CAUTIOUS && ratio < BOOT_LOAD_RATIO_SEVERE;
  const loadSevere = ratio !== undefined && ratio >= BOOT_LOAD_RATIO_SEVERE;
  const memoryCritical = signals.memoryPressure === "critical";

  let tier: BootPacingTier;
  const why: string[] = [];
  if (loadSevere || memoryCritical || (trouble.length > 0 && loadCautious)) {
    tier = "severe";
    why.push(...trouble);
    if (loadText && (loadSevere || loadCautious)) why.push(loadText);
    if (memoryCritical) why.push("memory pressure critical");
  } else if (trouble.length > 0 || loadCautious) {
    tier = "cautious";
    why.push(...trouble);
    if (loadCautious) why.push(loadText);
  } else {
    tier = "normal";
    why.push(loadText ? `no recent trouble, ${loadText}` : "no recent trouble");
  }
  return { tier, ...PLAN_BY_TIER[tier], reason: why.join("; ") };
}

/** The plan that binds repeating work `sinceBootMs` after boot: the boot plan
 * inside its hold, the normal bounds (with the boot tier and reason kept for
 * reporting) once the hold has passed. */
export function bootPacingAfter(plan: BootPacingPlan, sinceBootMs: number): BootPacingPlan {
  if (sinceBootMs < plan.holdMs) return plan;
  return { ...plan, ...PLAN_BY_TIER.normal, holdMs: plan.holdMs };
}
