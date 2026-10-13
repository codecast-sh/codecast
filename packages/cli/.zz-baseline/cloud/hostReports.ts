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
import type { CloudHostAction, CloudHostReport } from "@codecast/shared/contracts";

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
    images,
    logins_held: held,
    at: now,
  };
}

/** The `cast` arguments that carry out a web action on a host. */
export function hostActionArgs(action: CloudHostAction, hostId: string, imageId?: string): string[] {
  switch (action) {
    case "wake": return ["hosts", "wake", hostId];
    case "sleep": return ["hosts", "sleep", hostId];
    case "setup": return ["hosts", "setup", hostId, "--force"];
    case "image": return ["hosts", "image", hostId];
    case "delete_image":
      if (!imageId || !/^ami-[a-f0-9]+$/.test(imageId)) throw new Error("delete_image needs an image id");
      return ["hosts", "image", hostId, "--delete", imageId];
  }
}

export interface HostReportsDeps {
  runCast: (args: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  report: (hostDeviceId: string, report: CloudHostReport) => Promise<void>;
  hostIdForDevice: (hostDeviceId: string) => string | null;
  log: (line: string) => void;
}

/** The daemon's side: periodic reports, and the web's actions with their outcomes folded into the next report. */
export class HostReports {
  private lastAction = new Map<string, NonNullable<CloudHostReport["last_action"]>>();
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
      const last = this.lastAction.get(row.host_device_id);
      await this.deps.report(row.host_device_id, { ...row.report, ...(last ? { last_action: last } : {}) });
    }
  }

  async act(args: { host_device_id: string; action: CloudHostAction; image_id?: string }): Promise<string> {
    const hostId = this.deps.hostIdForDevice(args.host_device_id);
    if (!hostId) throw new Error("this laptop does not manage that cloud host");
    const cmd = hostActionArgs(args.action, hostId, args.image_id);
    const started = Date.now();
    this.lastAction.set(args.host_device_id, { action: args.action, status: "running", at: started });
    const r = await this.deps.runCast(cmd, { timeoutMs: 30 * 60_000 });
    const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").filter(Boolean).slice(-2).join(" · ").replace(/\x1b\[[0-9;]*m/g, "").slice(0, 400);
    this.lastAction.set(args.host_device_id, { action: args.action, status: r.code === 0 ? "ok" : "failed", ...(tail ? { detail: tail } : {}), at: Date.now() });
    await this.refresh();
    if (r.code !== 0) throw new Error(tail || `cast ${cmd.join(" ")} exited ${r.code}`);
    return tail;
  }
}
