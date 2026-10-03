import { RESOURCE_STALE_MS, sustainedResourcePressure, evaluateOffloadRequirements, type HostReadiness, type CloudHostReport } from "@codecast/shared/contracts";
import type { OffloadPlan, OffloadCandidate, ResourceMachine, ResourceSession } from "../components/resources/types";
import { eligibilityFor, type MigrationCandidate, type MigrationDevice } from "./migrationPlan";

export type OffloadDeviceEvidence = MigrationDevice & { platform?: string; host_readiness?: HostReadiness; cloud_host?: CloudHostReport };
export type OffloadPlanInput = {
  source: ResourceMachine;
  machines: ResourceMachine[];
  sessions: ResourceSession[];
  devices: OffloadDeviceEvidence[];
  candidates: MigrationCandidate[];
  blockedSessions?: Record<string, string>;
  now: number;
};

export function freshResourceMachine(machine: ResourceMachine, now: number): boolean {
  return machine.online && !!machine.snapshot && machine.receivedAt !== undefined && now - machine.receivedAt <= RESOURCE_STALE_MS && now - machine.snapshot.sample.at <= RESOURCE_STALE_MS && machine.snapshot.sample.at <= now + 30_000;
}

export function buildOffloadPlan(input: OffloadPlanInput): OffloadPlan | null {
  const { source, machines, sessions, devices, candidates, now } = input;
  const incident = sustainedResourcePressure(source.history, now);
  if (!incident || source.role !== "local" || !freshResourceMachine(source, now)) return null;
  const hosts = machines.filter(m => m.role === "cloud_linux" || m.role === "cloud_mac");
  const plan: OffloadPlan = {
    deviceId: source.deviceId, incident, generatedAt: source.snapshot!.sample.at,
    destinations: hosts.map(m => {
      const sample = freshResourceMachine(m, now) ? m.snapshot?.sample : undefined;
      const report = devices.find(d => d.device_id === m.deviceId)?.cloud_host;
      return { deviceId: m.deviceId, name: m.name, role: m.role, online: m.online, asleep: m.asleep,
        ...(sample ? { headroom: { ...(sample.cpuPercent === undefined ? {} : { cpuPercentFree: Math.max(0, 100 - sample.cpuPercent) }), memoryAvailable: sample.memoryAvailable } } : {}),
        ...(report?.hourly_usd !== undefined && now - report.at < 24 * 3600_000 ? { costPerHour: report.hourly_usd } : {}),
      };
    }), candidates: [], notOffered: [],
  };
  for (const session of sessions.filter(s => s.deviceId === source.deviceId)) {
    const migration = candidates.find(c => c._id === session.conversationId);
    const processes = source.snapshot!.processes.filter(p => p.sessionId === session.sessionId);
    const shared = source.snapshot!.processes.some(p => p.sharedSessionIds?.includes(session.sessionId));
    const reason = session.pinned ? "Pinned sessions stay on this machine unless you move them manually"
      : input.blockedSessions?.[session.sessionId]
      ?? (session.state === "dead" || session.state === "hibernated" ? "No live agent to offload"
      : !migration ? "Migration eligibility has not been loaded for this session"
      : !["claude", "claude_code", "claude-code", ""].includes((migration.agent_type ?? "").toLowerCase()) ? "This harness does not support session transfer yet"
      : shared ? "This session shares a process with other sessions"
      : processes.length === 0 ? "No exclusive process ownership was measured"
      : null);
    if (reason || !migration) { plan.notOffered.push({ sessionId: session.sessionId, reason: reason ?? "No transfer candidate" }); continue; }
    const rss = processes.reduce((n, p) => n + p.rss, 0);
    const cpu = processes.reduce((n, p) => n + p.cpu, 0);
    const macRequired = processes.some(p => p.kind === "simulator" || /xcodebuild|simctl|codesign/i.test(p.name));
    const perDestination: OffloadCandidate["perDestination"] = {};
    for (const host of hosts) {
      const device = devices.find(d => d.device_id === host.deviceId);
      const eligibility = eligibilityFor(migration, device, devices);
      const checks = evaluateOffloadRequirements({ processes, targetPlatform: device?.platform, targetOnline: host.online,
        targetWakeable: !!host.asleep, readiness: device?.host_readiness,
        targetSample: freshResourceMachine(host, now) ? host.snapshot?.sample : undefined, now });
      if (!eligibility.ok) checks.blockers.unshift(eligibility.reason);
      perDestination[host.deviceId] = { readiness: checks.blockers.length ? "blocked" : "preflight_required", ...checks };
    }
    const viable = hosts.filter(h => perDestination[h.deviceId].readiness === "preflight_required").sort((a, b) => {
      return (macRequired ? Number(b.role === "cloud_mac") - Number(a.role === "cloud_mac") : 0)
        || Number(b.online) - Number(a.online)
        || Number(freshResourceMachine(b, now)) - Number(freshResourceMachine(a, now))
        || Number(b.role === "cloud_linux") - Number(a.role === "cloud_linux");
    });
    plan.candidates.push({
      sessionId: session.sessionId, reason: `${processes.length} exclusively attributed processes; ${cpu.toFixed(0)}% CPU across cores${macRequired ? "; Apple tooling observed" : "; project portability still needs verification"}`,
      ...(macRequired ? { requiresMac: "Apple build or simulator tooling observed in the process tree" } : {}),
      confidence: "low", relief: { cpu, rssLow: 0, rssHigh: rss },
      staysLocal: source.snapshot!.processes.filter(p => !p.sessionId && ["browser", "simulator", "tool"].includes(p.kind)).slice(0, 4).map(p => ({ label: p.name, pid: p.pid, cpu: p.cpu, rss: p.rss, why: "Not owned exclusively by this session; moving it will not stop this process" })),
      disruption: session.state === "working" ? "mid_turn" : "idle", perDestination,
      ...(viable[0] ? { suggestedDestinationId: viable[0].deviceId } : {}),
    });
  }
  plan.candidates.sort((a, b) => Number(a.disruption === "mid_turn") - Number(b.disruption === "mid_turn") || (b.relief.cpu ?? 0) - (a.relief.cpu ?? 0) || (b.relief.rssHigh ?? 0) - (a.relief.rssHigh ?? 0));
  return plan;
}
