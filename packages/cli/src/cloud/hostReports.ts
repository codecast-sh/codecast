/**
 * The laptop's report on each cloud host it manages (CloudHostReport, onto
 * the host's device row) and the web's actions on a host (cloud_host_action).
 *
 * Building a report makes blocking AWS calls, so it runs in a child
 * (`cast hosts report --json`); so does every action (`cast hosts wake`,
 * `sleep`, `setup --force`, `image`, `image --delete`). The daemon keeps each
 * host's last action and its outcome and folds them into the next report.
 */

import type { CloudHost } from "../browser/cloudHost.js";
import { inspectHost } from "../browser/cloudHost.js";
import { estimateHostCost } from "../hosts/cli.js";
import { listImages } from "../hosts/image.js";
import { collectAgentAuthBundle, laptopHome } from "../remote/agentAuth.js";
import { remoteHome } from "../remote/session-move.js";
import { toRemoteHost } from "../browser/cloudHost.js";
import { CLOUD_HOST_SIZES, isCloudHostSize, parseWakePhaseLine, type CloudHostAction, type CloudHostReport } from "@codecast/shared/contracts";

export function buildCloudHostReport(host: CloudHost, managedBy: string, now = Date.now()): CloudHostReport {
  const facts = inspectHost(host);
  const cost = estimateHostCost({ instanceType: facts.instanceType, volumeGiB: facts.volumeGiB, state: facts.state });
  let images: CloudHostReport["images"] = [];
  if (host.provider === "aws") {
    try { images = listImages({ region: host.region ?? "us-west-2", profile: host.profile }, host.platform ?? facts.platform ?? "linux").slice(0, 10).map(({ id, name, created }) => ({ id, name, created })); } catch { /* no image permission: none shown */ }
  }
  let held: CloudHostReport["logins_held"] = [];
  try {
    const { skipped } = collectAgentAuthBundle({ home: laptopHome(), userId: "report", deviceId: managedBy, hostHome: remoteHome(toRemoteHost(host)) });
    held = skipped.filter((s) => !/^no login$|^missing$|not shipped$/.test(s.reason)).map((s) => ({ id: s.id, reason: s.reason }));
  } catch { /* the login read is the only field this loses */ }
  const state = (["running", "stopped", "pending", "stopping", "missing"] as const).includes(facts.state as any) ? facts.state as CloudHostReport["state"] : "unknown";
  return {
    managed_by: managedBy,
    instance_id: host.id,
    provider: host.provider,
    ...(host.region ? { region: host.region } : {}),
    ...(facts.instanceType ? { instance_type: facts.instanceType } : {}),
    state,
    ...(cost.hourlyUsd !== null ? { hourly_usd: cost.hourlyUsd } : {}),
    ...(cost.diskMonthlyUsd !== null ? { disk_monthly_usd: Math.round(cost.diskMonthlyUsd * 100) / 100 } : {}),
    ...(facts.volumeGiB !== undefined ? { disk_gib: facts.volumeGiB } : {}),
    ...(host.idleStopMinutes !== undefined ? { idle_stop_minutes: host.idleStopMinutes } : {}),
    ...(host.autoscaled ? { autoscaled: true } : {}),
    images,
    logins_held: held,
    at: now,
  };
}

/** The `cast` arguments that carry out a web action on a host. */
export function hostActionArgs(action: CloudHostAction, hostId: string, imageId?: string, instanceType?: string): string[] {
  switch (action) {
    case "clone":
      // Linux only: a Mac needs a dedicated host allocated first (24-hour minimum).
      if (!isCloudHostSize(instanceType)) throw new Error(`clone needs a host size (${CLOUD_HOST_SIZES.map((s) => s.type).join(", ")})`);
      return ["hosts", "create", "linux", "--like", hostId, "--type", instanceType];
    case "wake": return ["hosts", "wake", hostId];
    case "sleep": return ["hosts", "sleep", hostId];
    case "setup": return ["hosts", "setup", hostId, "--force"];
    case "image": return ["hosts", "image", hostId];
    case "delete_image":
      if (!imageId || !/^ami-[a-f0-9]+$/.test(imageId)) throw new Error("delete_image needs an image id");
      return ["hosts", "image", hostId, "--delete", imageId];
  }
}

/** At most one report per this while a wake passes its phases: a phase the web misses is replaced by the next one within it. */
export const PHASE_REPORT_MIN_MS = 3_000;

export interface HostReportsDeps {
  runCast: (args: string[], opts?: { timeoutMs?: number; onStdoutLine?: (line: string) => void }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  report: (hostDeviceId: string, report: CloudHostReport) => Promise<void>;
  hostIdForDevice: (hostDeviceId: string) => string | null;
  log: (line: string) => void;
  /** Tests shorten the phase report window; the daemon keeps PHASE_REPORT_MIN_MS. */
  phaseReportMinMs?: number;
}

/** The daemon's side: periodic reports, and every action on a host (the web's, and the wakes queued work asks for) with its outcome folded into the next report. */
export class HostReports {
  private lastAction = new Map<string, NonNullable<CloudHostReport["last_action"]>>();
  private lastReport = new Map<string, CloudHostReport>();
  private running: Promise<void> | null = null;

  constructor(private deps: HostReportsDeps) {}

  /** One report pass for every registered host (serialized: a pass asked for during one runs after it). */
  async refresh(): Promise<void> {
    while (this.running) await this.running;
    this.running = this.refreshOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private async refreshOnce(): Promise<void> {
    const r = await this.deps.runCast(["hosts", "report", "--json"], { timeoutMs: 3 * 60_000 });
    let rows: Array<{ host_device_id: string; report?: CloudHostReport; error?: string }> = [];
    try { rows = JSON.parse(r.stdout.trim().split("\n").pop() ?? "[]"); } catch { this.deps.log(`[HOSTS] report failed: ${r.stderr.trim().split("\n").pop() ?? `exit ${r.code}`}`); return; }
    for (const row of rows) {
      if (!row.report) { this.deps.log(`[HOSTS] report for ${row.host_device_id.slice(0, 8)} failed: ${row.error}`); continue; }
      this.lastReport.set(row.host_device_id, row.report);
      await this.send(row.host_device_id, row.report);
    }
  }

  private async send(hostDeviceId: string, report: CloudHostReport): Promise<void> {
    const last = this.lastAction.get(hostDeviceId);
    await this.deps.report(hostDeviceId, { ...report, ...(last ? { last_action: last } : {}) });
  }

  /**
   * One action's child, with the web watching: "running" goes out the moment
   * it starts (on the last report, or a fresh pass when there is none yet),
   * and the outcome rides a fresh report once it ends.
   */
  async run(hostDeviceId: string, action: CloudHostAction, cmd: string[], timeoutMs: number): Promise<{ ok: boolean; code: number | null; tail: string }> {
    const started = Date.now();
    this.lastAction.set(hostDeviceId, { action, status: "running", at: started });
    const failed = (what: string) => (err: unknown) => this.deps.log(`[HOSTS] ${action} ${what} report failed: ${err instanceof Error ? err.message : String(err)}`);
    const known = this.lastReport.get(hostDeviceId);
    void (known ? this.send(hostDeviceId, known) : this.refresh()).catch(failed("start"));

    // Each phase the child announces rides the running action's detail, at
    // most one report per PHASE_REPORT_MIN_MS; the last phase inside a window
    // goes out when it closes. Without a report to fold it into (the first
    // pass still running), a phase waits for that pass, which carries it.
    let lastSent = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const flush = () => {
      pending = null;
      const base = this.lastReport.get(hostDeviceId);
      if (done || !base) return;
      lastSent = Date.now();
      void this.send(hostDeviceId, base).catch(failed("phase"));
    };
    const onStdoutLine = (line: string) => {
      const phase = parseWakePhaseLine(line);
      if (!phase || done) return;
      this.lastAction.set(hostDeviceId, { action, status: "running", detail: phase, at: started });
      if (pending) return;
      const wait = Math.max(0, lastSent + (this.deps.phaseReportMinMs ?? PHASE_REPORT_MIN_MS) - Date.now());
      pending = setTimeout(flush, wait);
    };
    const r = await this.deps.runCast(cmd, { timeoutMs, onStdoutLine });
    done = true;
    if (pending) clearTimeout(pending);
    const out = r.stdout.split("\n").filter((l) => !parseWakePhaseLine(l)).join("\n");
    const tail = `${out}\n${r.stderr}`.trim().split("\n").filter(Boolean).slice(-2).join(" · ").replace(/\x1b\[[0-9;]*m/g, "").slice(0, 400);
    this.lastAction.set(hostDeviceId, { action, status: r.code === 0 ? "ok" : "failed", ...(tail ? { detail: tail } : {}), at: Date.now() });
    await this.refresh();
    return { ok: r.code === 0, code: r.code, tail };
  }

  async act(args: { host_device_id: string; action: CloudHostAction; image_id?: string; instance_type?: string }): Promise<string> {
    const hostId = this.deps.hostIdForDevice(args.host_device_id);
    if (!hostId) throw new Error("this laptop does not manage that cloud host");
    const cmd = hostActionArgs(args.action, hostId, args.image_id, args.instance_type);
    const r = await this.run(args.host_device_id, args.action, cmd, 30 * 60_000);
    if (!r.ok) throw new Error(r.tail || `cast ${cmd.join(" ")} exited ${r.code}`);
    return r.tail;
  }
}
