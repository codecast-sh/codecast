import type { HostReadiness } from "./cloudHostReport";
import { fmtBytes, type ResourcePoint, type ResourceProcess } from "./systemResources";

/** A session working on this much local data runs where the data is. */
export const LOCAL_DATA_BLOCK_BYTES = 1024 ** 3;

/** The local files a session's processes are working on, totalled, with the place holding most of them. */
export function sessionLocalData(processes: ResourceProcess[]): { bytes: number; root: string } | undefined {
  const held = processes.filter(p => p.localData);
  if (!held.length) return undefined;
  const top = held.reduce((a, b) => (b.localData!.bytes > a.localData!.bytes ? b : a));
  return { bytes: held.reduce((n, p) => n + p.localData!.bytes, 0), root: top.localData!.root };
}

export interface OffloadRequirements {
  processes: ResourceProcess[];
  targetPlatform?: string;
  targetOnline: boolean;
  targetWakeable: boolean;
  readiness?: HostReadiness;
  targetSample?: ResourcePoint;
  now: number;
}

export function evaluateOffloadRequirements(input: OffloadRequirements) {
  const { processes, readiness, targetSample, now } = input;
  const blockers: string[] = [], pending: string[] = [], passed: string[] = [], notes: string[] = [];
  const requiresMac = processes.some(p => p.kind === "simulator" || /xcodebuild|simctl|codesign/i.test(p.name));
  if (requiresMac && input.targetPlatform !== "darwin") blockers.push("Observed Apple build or simulator tooling requires a Mac");
  const data = sessionLocalData(processes);
  if (data && data.bytes >= LOCAL_DATA_BLOCK_BYTES) blockers.push(`Works on ${fmtBytes(data.bytes)} of local files in ${data.root}`);
  if (!input.targetOnline && !input.targetWakeable) blockers.push("The destination is offline");
  if (processes.some(p => p.kind === "browser" || p.kind === "simulator" || p.kind === "app")) blockers.push("The process tree contains a local browser, app or simulator; its live state cannot be transferred safely");
  if (!readiness || now - readiness.at > 10 * 60_000 || readiness.at > now + 30_000) pending.push("Refresh the destination's tools, setup and login report");
  else {
    if (readiness.setup?.ok === false) blockers.push(`Host setup failed: ${readiness.setup.error ?? readiness.setup.step ?? "unknown step"}`);
    else if (!readiness.setup) pending.push("Verify the project's packages and services on this host");
    else passed.push("The host reports its setup completed");
    // The inventory covers helpers the laptop's own hooks and skills call (sounds, OS notifications), not
    // what a session needs to run: a hook whose helper is absent fails on its own, so it never stops a move.
    if (readiness.tools?.missing.length) notes.push(`Hooks call tools this host lacks: ${readiness.tools.missing.map(t => t.tool).join(", ")}`);
    else if (!readiness.tools) pending.push("Verify required command-line tools");
    else passed.push("The host reports no missing tools in its inventory");
    if (!readiness.mirror?.complete) pending.push("Verify configuration and credential transfer");
    else passed.push("The host reports its configuration mirror complete");
  }
  if (!targetSample) pending.push("Measure available memory and CPU on the destination");
  else if (targetSample.pressure === "critical" || targetSample.pressure === "elevated" || (targetSample.cpuPercent ?? 0) >= 90 || targetSample.load1 / Math.max(targetSample.logicalCpus, 1) >= 3) blockers.push("The destination is already under heavy pressure");
  else if (targetSample.memoryAvailable < processes.reduce((n, p) => n + p.rss, 0)) pending.push("Confirm memory headroom; measured session RSS exceeds reported available memory");
  else passed.push("The latest destination sample has headroom for the observed process RSS");
  pending.push("Verify this project's OS/architecture, secrets, services and network access");
  pending.push("Confirm the session does not depend on this laptop's browser login or attached devices");
  return {
    blockers, pending, passed, notes,
    fit: requiresMac ? "Apple build tooling was observed; this work needs a Mac" : "No Apple-only tooling was observed; Linux remains provisional until project requirements are checked",
    requiresMac: requiresMac ? "Apple build or simulator tooling observed in the process tree" : undefined,
  };
}
