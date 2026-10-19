import { sustainedResourcePressure, evaluateOffloadRequirements, type HostReadiness, type CloudHostReport, type ResourcePoint } from "@codecast/shared/contracts";
import { freshness, memoryUsed } from "../components/resources/resourceModel";
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
  return freshness(machine, now) === "live";
}

export function buildOffloadPlan(input: OffloadPlanInput): OffloadPlan | null {
  const { source, machines, sessions, candidates, now } = input;
  // The source is reporting, so it is up even when its device heartbeat lags;
  // otherwise every session reads as stranded on an offline machine.
  const devices = input.devices.map(d => d.device_id === source.deviceId && !d.online ? { ...d, online: true } : d);
  // Offered whenever the laptop is reporting live, so load can be moved off any
  // time; the incident only colors the review.
  if (source.role !== "local" || !freshResourceMachine(source, now)) return null;
  const incident = sustainedResourcePressure(source.history, now);
  const hosts = machines.filter(m => m.role === "cloud_linux" || m.role === "cloud_mac");
  const plan: OffloadPlan = {
    deviceId: source.deviceId, sourceSample: source.snapshot!.sample, incident, generatedAt: source.snapshot!.sample.at,
    destinations: hosts.map(m => {
      const sample = freshResourceMachine(m, now) ? m.snapshot?.sample : undefined;
      const report = devices.find(d => d.device_id === m.deviceId)?.cloud_host;
      return { deviceId: m.deviceId, name: m.name, role: m.role, online: m.online, asleep: m.asleep,
        ...(sample ? { sample } : {}),
        ...(report?.hourly_usd !== undefined && now - report.at < 24 * 3600_000 ? { costPerHour: report.hourly_usd } : {}),
      };
    }), candidates: [], notOffered: [], staying: [],
  };
  for (const session of sessions.filter(s => s.deviceId === source.deviceId)) {
    const migration = candidates.find(c => c._id === session.conversationId);
    const processes = source.snapshot!.processes.filter(p => p.sessionId === session.sessionId);
    const shared = source.snapshot!.processes.some(p => p.sharedSessionIds?.includes(session.sessionId));
    // Short labels: the review groups sessions under them with a count.
    const reason = session.pinned ? "Pinned"
      : input.blockedSessions?.[session.sessionId]
      ?? (session.state === "dead" || session.state === "hibernated" ? "Not running"
      : !migration ? "Not movable"
      : !["claude", "claude_code", "claude-code", ""].includes((migration.agent_type ?? "").toLowerCase()) ? "Not Claude Code"
      : shared ? "Shares a process"
      : processes.length === 0 ? "No process found"
      : null);
    if (reason || !migration) { plan.notOffered.push({ sessionId: session.sessionId, reason: reason ?? "Not movable" }); continue; }
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
      stops: [...processes].sort((a, b) => b.cpu - a.cpu || b.rss - a.rss).map(p => ({ label: p.name, pid: p.pid, cpu: p.cpu, rss: p.rss, ...(p.detached ? { detached: p.detached } : {}) })),
      staysLocal: source.snapshot!.processes.filter(p => !p.sessionId && ["browser", "simulator", "tool"].includes(p.kind)).slice(0, 4).map(p => ({ label: p.name, pid: p.pid, cpu: p.cpu, rss: p.rss, why: "Not owned exclusively by this session; moving it will not stop this process" })),
      disruption: session.state === "working" ? "mid_turn" : "idle", perDestination,
      ...(viable[0] ? { suggestedDestinationId: viable[0].deviceId } : {}),
    });
  }
  plan.candidates.sort((a, b) => Number(a.disruption === "mid_turn") - Number(b.disruption === "mid_turn") || (b.relief.cpu ?? 0) - (a.relief.cpu ?? 0) || (b.relief.rssHigh ?? 0) - (a.relief.rssHigh ?? 0));
  plan.staying = stayingSessions(plan, source, sessions.filter(s => s.deviceId === source.deviceId));
  return plan;
}

/** A session using at least this much of one core is doing work worth naming when it cannot move. */
export const STAYING_BUSY_CPU = 25;

/** The reason a candidate cannot move anywhere: a blocker every destination shares, else the first one. */
function stayReason(c: OffloadCandidate): string {
  const lists = Object.values(c.perDestination).map(r => r.blockers);
  return lists[0]?.find(b => lists.every(l => l.includes(b))) ?? lists.flat()[0] ?? "Blocked";
}

function stayingSessions(plan: OffloadPlan, source: ResourceMachine, sessions: ResourceSession[]): OffloadPlan["staying"] {
  const processes = source.snapshot!.processes;
  const asked = new Set(source.backgroundSessions ?? []);
  const reasons = new Map<string, string>(plan.notOffered.map(n => [n.sessionId, n.reason]));
  for (const c of plan.candidates) {
    if (!Object.values(c.perDestination).some(r => r.readiness === "ready" || r.readiness === "preflight_required")) reasons.set(c.sessionId, stayReason(c));
  }
  const out: OffloadPlan["staying"] = [];
  for (const s of sessions) {
    const reason = reasons.get(s.sessionId);
    if (!reason) continue;
    const own = processes.filter(p => p.sessionId === s.sessionId);
    const cpu = own.reduce((n, p) => n + p.cpu, 0);
    if (cpu < STAYING_BUSY_CPU && !asked.has(s.sessionId)) continue;
    out.push({ sessionId: s.sessionId, reason, cpu, rss: own.reduce((n, p) => n + p.rss, 0), background: asked.has(s.sessionId), lowered: own.filter(p => p.background).length, processCount: own.length });
  }
  return out.sort((a, b) => b.cpu - a.cpu);
}

/** A machine's load as a share of its capacity: CPU across every core, memory in use. */
export type LoadShare = { cpu?: number; memory: number };

/**
 * Load before and after sessions leave (`sign` -1) or arrive (+1). Session CPU
 * counts one core as 100, so it is spread over the machine's cores. Resident
 * memory counts shared pages, so a source's "after" is the best case.
 */
export function loadShift(sample: ResourcePoint, moved: { cpu?: number; rss: number }, sign: 1 | -1): { before: LoadShare; after: LoadShare } {
  // Past 100 is kept: it is how much a host would be oversubscribed, which ranks hosts that cannot hold a batch.
  const pct = (bytes: number) => sample.memoryTotal > 0 ? Math.max(0, (bytes / sample.memoryTotal) * 100) : 0;
  const used = memoryUsed(sample);
  const cpuAfter = sample.cpuPercent === undefined || moved.cpu === undefined ? undefined
    : Math.max(0, sample.cpuPercent + sign * moved.cpu / Math.max(sample.logicalCpus, 1));
  return {
    before: { cpu: sample.cpuPercent, memory: pct(used) },
    after: { cpu: cpuAfter, memory: pct(used + sign * moved.rss) },
  };
}

/** A destination is full past this share of CPU or memory; Auto spills the rest onto the next host. */
export const SPREAD_CEILING = 80;

/**
 * Where each picked session goes. A named destination takes every session it
 * can; "auto" fills hosts in preference order (online, measured, Linux,
 * cheaper) up to SPREAD_CEILING and spills the rest onto the next one, so a
 * second host wakes only when the first is full. A session no measured host
 * can hold goes where it pushes load the least.
 */
export function assignDestinations(plan: OffloadPlan, picked: OffloadCandidate[], mode: string): Map<string, string> {
  const movable = (c: OffloadCandidate, id: string) => ["ready", "preflight_required"].includes(c.perDestination[id]?.readiness ?? "");
  const out = new Map<string, string>();
  if (mode !== "auto") {
    for (const c of picked) {
      const id = movable(c, mode) ? mode : c.suggestedDestinationId;
      if (id) out.set(c.sessionId, id);
    }
    return out;
  }
  const order = [...plan.destinations].sort((a, b) =>
    Number(b.online) - Number(a.online) || Number(!!b.sample) - Number(!!a.sample)
    || Number(b.role === "cloud_linux") - Number(a.role === "cloud_linux") || (a.costPerHour ?? Infinity) - (b.costPerHour ?? Infinity));
  const added = new Map(order.map((d) => [d.deviceId, { cpu: 0, rss: 0 }]));
  const peak = (id: string, extra: OffloadCandidate) => {
    const d = order.find((x) => x.deviceId === id)!;
    if (!d.sample) return undefined;
    const sum = added.get(id)!;
    const { after } = loadShift(d.sample, { cpu: sum.cpu + (extra.relief.cpu ?? 0), rss: sum.rss + (extra.relief.rssHigh ?? 0) }, 1);
    return Math.max(after.cpu ?? 0, after.memory);
  };
  for (const c of [...picked].sort((a, b) => (b.relief.rssHigh ?? 0) - (a.relief.rssHigh ?? 0))) {
    const options = order.filter((d) => movable(c, d.deviceId));
    if (!options.length) continue;
    const fits = options.find((d) => { const p = peak(d.deviceId, c); return p === undefined || p <= SPREAD_CEILING; });
    const pick = fits ?? options.reduce((best, d) => (peak(d.deviceId, c) ?? Infinity) < (peak(best.deviceId, c) ?? Infinity) ? d : best);
    out.set(c.sessionId, pick.deviceId);
    const sum = added.get(pick.deviceId)!;
    sum.cpu += c.relief.cpu ?? 0;
    sum.rss += c.relief.rssHigh ?? 0;
  }
  return out;
}

/** A candidate's share of the source's load: the mean of its share of the CPU and of the memory in use. */
export function loadShareOf(c: OffloadCandidate, sample: ResourcePoint): number {
  const cpuUsed = (sample.cpuPercent ?? 0) * Math.max(sample.logicalCpus, 1);
  const memUsed = memoryUsed(sample);
  const cpu = cpuUsed > 0 ? Math.min(1, (c.relief.cpu ?? 0) / cpuUsed) : 0;
  const mem = memUsed > 0 ? Math.min(1, (c.relief.rssHigh ?? 0) / memUsed) : 0;
  return cpuUsed > 0 ? (cpu + mem) / 2 : mem;
}

/**
 * The cheapest set of sessions that moves `percent` of the load these
 * candidates carry between them. Idle sessions go before working ones (a
 * working one waits for its turn to end). Within that order each step takes
 * the smallest session that finishes the target, or the largest when none
 * does, so the fewest sessions and the least extra load move; a final pass
 * drops any session the target no longer needs. Returns the ids in move order
 * and the share of the candidates' load actually covered.
 */
export function sliceForPercent(candidates: OffloadCandidate[], sample: ResourcePoint, percent: number): { ids: string[]; share: number } {
  const EPS = 1e-9;
  const raw = candidates.map((c) => ({ c, share: loadShareOf(c, sample) })).filter((r) => r.share > 0);
  const total = raw.reduce((n, r) => n + r.share, 0);
  const target = Math.max(0, Math.min(100, percent)) / 100;
  if (total === 0 || target === 0) return { ids: [], share: 0 };
  const pool = raw.map((r) => ({ ...r, share: r.share / total }));
  const picked: typeof pool = [];
  let sum = 0;
  while (sum + EPS < target) {
    const tier = pool.filter((r) => r.c.disruption !== "mid_turn");
    const left = tier.length ? tier : pool;
    if (!left.length) break;
    const need = target - sum;
    const finishing = left.filter((r) => r.share + EPS >= need).sort((a, b) => a.share - b.share)[0];
    const next = finishing ?? left.reduce((a, b) => (b.share > a.share ? b : a));
    pool.splice(pool.indexOf(next), 1);
    picked.push(next);
    sum += next.share;
  }
  for (const r of [...picked].sort((a, b) => a.share - b.share)) {
    if (sum - r.share + EPS >= target) { picked.splice(picked.indexOf(r), 1); sum -= r.share; }
  }
  return { ids: picked.map((r) => r.c.sessionId), share: sum };
}
