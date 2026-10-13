/**
 * The daily live check of a cloud agent provider's API (pl-798's canary),
 * run as a trigger's precheck by scripts/cloud-agent-canary.ts: one list page
 * and one agent mirrored through the adapter's own read path, so the same
 * shape guard and renderer the watcher uses judge the answers. It reads only,
 * writes nothing but its own state file, and prints no token or payload.
 *
 * Its exit code is the precheck's answer. The precheck skips the run only on
 * CANARY_EXIT.clean and CANARY_EXIT.quiet; every other code runs it, so a
 * canary that crashes (bun's own exit 1) is heard the day it breaks.
 *
 * A canary that can't check is quiet for a while, then says so: the first
 * failed check is kept in the state file, and once checks have failed for
 * UNCHECKED_ALERT_MS the trigger runs, at most once per that span, until a
 * check gets through.
 */
import * as fs from "fs";
import * as path from "path";
import { cloudApiVerdict } from "./apiError.js";
import { CloudShapeError } from "./shape.js";
import { CloudAgentSetupError, errorText, type CloudAgentAdapter, type CloudAgentHandle } from "./types.js";

export const CANARY_EXIT = {
  /** The API changed (a shape break or an answer it does not expect), or no check got through for UNCHECKED_ALERT_MS: run the trigger. */
  changed: 0,
  /** It read cleanly: skip. */
  clean: 10,
  /** It could not check (no sign-in, an outage, a limit): skip, nothing to report yet. */
  quiet: 11,
} as const;

/** How long the canary may go without a check before the trigger hears of it. */
export const UNCHECKED_ALERT_MS = 3 * 24 * 60 * 60_000;

/** What one check found: `changed` and `clean` got through; `unchecked` did not. */
export type CanaryOutcome = { kind: "changed" | "clean" | "unchecked"; line: string };

/** Whether a failure means the provider's API changed (what the watcher's kill switch pauses on). */
function changedApi(err: unknown, listed: boolean): boolean {
  return err instanceof CloudShapeError || cloudApiVerdict(err, { oneAgent: listed, listed }) === "unexpected";
}

/** One check: the list's first page, then its first agent mirrored. Never throws: a failure it does not recognize is one it could not check through. */
export async function checkCloudAgent(adapter: CloudAgentAdapter<any, any, any>): Promise<CanaryOutcome> {
  const label = adapter.spec.label;
  const failed = (step: string, err: unknown, listed: boolean): CanaryOutcome => changedApi(err, listed)
    ? { kind: "changed", line: `${label} ${step}: CHANGED: ${errorText(err)}` }
    : { kind: "unchecked", line: `${label} ${step}: could not check: ${errorText(err)}` };
  let client: unknown;
  try {
    client = adapter.client();
  } catch (err) {
    return failed("sign-in", err, false);
  }
  if (client instanceof CloudAgentSetupError) return { kind: "unchecked", line: `${label}: could not check: ${client.message}` };
  let first;
  try {
    first = (await adapter.listAgents(client)).items[0];
  } catch (err) {
    return failed("list", err, false);
  }
  if (!first) return { kind: "clean", line: `${label}: list read cleanly, no agents to read` };
  const handle: CloudAgentHandle<unknown> = {
    agentId: first.id,
    data: () => adapter.loadData(undefined),
    save: () => {},
    notice: async () => undefined,
    scheduleRender: () => {},
    follow: async () => {},
    log: () => {},
  };
  try {
    const mirrored = await adapter.mirror(client, handle, first.agent);
    if (!mirrored?.transcript) return failed("mirror", new CloudShapeError("", "a rendered transcript", "none", first.id), true);
  } catch (err) {
    return failed("mirror", err, true);
  }
  return { kind: "clean", line: `${label}: list and one agent read cleanly` };
}

/**
 * The exit code for an outcome, and the line to print. A check that got
 * through clears the unchecked stretch; one that did not starts or extends
 * it, and runs the trigger once it has lasted UNCHECKED_ALERT_MS (once per
 * that span).
 */
export function settleCanary(outcome: CanaryOutcome, stateFile: string, now = Date.now()): { code: number; line: string } {
  if (outcome.kind !== "unchecked") {
    fs.rmSync(stateFile, { force: true });
    return { code: outcome.kind === "changed" ? CANARY_EXIT.changed : CANARY_EXIT.clean, line: outcome.line };
  }
  let state: { since?: number; alertedAt?: number } = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
  const since = typeof state.since === "number" ? state.since : now;
  const days = Math.floor((now - since) / (24 * 60 * 60_000));
  const due = now - since >= UNCHECKED_ALERT_MS && now - (state.alertedAt ?? 0) >= UNCHECKED_ALERT_MS;
  const alertedAt = due ? now : state.alertedAt;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, JSON.stringify({ since, ...(alertedAt ? { alertedAt } : {}) }), { mode: 0o600 });
  return {
    code: due ? CANARY_EXIT.changed : CANARY_EXIT.quiet,
    line: days > 0 ? `${outcome.line} (no check got through for ${days} day${days === 1 ? "" : "s"})` : outcome.line,
  };
}

/** The canary for one provider (by spec id), with its state under `configDir`. */
export async function runCanary(adapters: CloudAgentAdapter<any, any, any>[], providerId: string, configDir: string, now = Date.now()): Promise<{ code: number; line: string }> {
  const stateFile = path.join(configDir, "cloud-agent-canary", `${providerId}.json`);
  const adapter = adapters.find((a) => a.spec.id === providerId);
  const outcome: CanaryOutcome = adapter ? await checkCloudAgent(adapter) : { kind: "unchecked", line: `no cloud agent provider "${providerId}"` };
  return settleCanary(outcome, stateFile, now);
}
