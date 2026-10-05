// Pure attribution for the resource monitor. One machine snapshot becomes
// rows whose totals add up to the machine's own per-kind totals exactly:
// every process lands in one row, a process several sessions share gets a
// row of its own (named once, never added to each session), and whatever the
// snapshot did not list is carried by the unattributed row as a remainder.
import {
  RESOURCE_STALE_MS,
  type MachineResourceSnapshot,
  type ResourceKind,
  type ResourcePoint,
  type ResourceProcess,
} from "@codecast/shared/contracts";
import type { ResourceMachine, ResourceSession } from "./types";

export const KINDS: ResourceKind[] = ["agent", "tool", "browser", "simulator", "app", "system"];
export const KIND_LABEL: Record<ResourceKind, string> = {
  agent: "Agents",
  tool: "Tools",
  browser: "Browsers",
  simulator: "Simulators",
  app: "Apps",
  system: "System",
};

export type Usage = { cpu: number; rss: number; count: number };
const zero = (): Usage => ({ cpu: 0, rss: 0, count: 0 });
const add = (u: Usage, cpu: number, rss: number, count = 1) => { u.cpu += cpu; u.rss += rss; u.count += count; };

export type AttributionRow = {
  key: string;
  deviceId: string;
  type: "session" | "shared" | "unattributed";
  sessionId?: string;
  /** Sessions a shared row serves. */
  sharedWith?: string[];
  usage: Usage;
  byKind: Partial<Record<ResourceKind, Usage>>;
  processes: ResourceProcess[];
  /** Processes the machine counted but did not list (unattributed row only). */
  remainder?: Usage;
};

/** Session ids a process serves, deduped; length >= 2 means shared. */
function owners(p: ResourceProcess): string[] {
  const ids = new Set<string>();
  if (p.sessionId) ids.add(p.sessionId);
  for (const id of p.sharedSessionIds ?? []) ids.add(id);
  return [...ids].sort();
}

export function attribute(deviceId: string, snap: MachineResourceSnapshot): AttributionRow[] {
  const rows = new Map<string, AttributionRow>();
  const row = (key: string, init: () => Omit<AttributionRow, "usage" | "byKind" | "processes" | "key" | "deviceId">) => {
    let r = rows.get(key);
    if (!r) { r = { key, deviceId, usage: zero(), byKind: {}, processes: [], ...init() }; rows.set(key, r); }
    return r;
  };
  const listed: Record<string, Usage> = {};
  for (const p of snap.processes) {
    const ids = owners(p);
    const r = ids.length === 0
      ? row(`${deviceId}:unattributed`, () => ({ type: "unattributed" }))
      : ids.length === 1
        ? row(`${deviceId}:s:${ids[0]}`, () => ({ type: "session", sessionId: ids[0] }))
        : row(`${deviceId}:shared:${ids.join(",")}`, () => ({ type: "shared", sharedWith: ids }));
    r.processes.push(p);
    add(r.usage, p.cpu, p.rss);
    add((r.byKind[p.kind] ??= zero()), p.cpu, p.rss);
    add((listed[p.kind] ??= zero()), p.cpu, p.rss);
  }
  // What the groups counted beyond the listed processes belongs to nobody we can name.
  const remainder = zero();
  const remainderByKind: Partial<Record<ResourceKind, Usage>> = {};
  for (const g of snap.groups) {
    const l = listed[g.kind] ?? zero();
    const extra = { cpu: Math.max(0, g.cpu - l.cpu), rss: Math.max(0, g.rss - l.rss), count: Math.max(0, g.processCount - l.count) };
    if (extra.cpu || extra.rss || extra.count) {
      add(remainder, extra.cpu, extra.rss, extra.count);
      remainderByKind[g.kind] = extra;
    }
  }
  if (remainder.count || remainder.cpu || remainder.rss) {
    const u = row(`${deviceId}:unattributed`, () => ({ type: "unattributed" }));
    u.remainder = remainder;
    add(u.usage, remainder.cpu, remainder.rss, remainder.count);
    for (const [k, v] of Object.entries(remainderByKind) as [ResourceKind, Usage][]) add((u.byKind[k] ??= zero()), v.cpu, v.rss, v.count);
  }
  for (const r of rows.values()) r.processes.sort((a, b) => b.cpu - a.cpu || b.rss - a.rss);
  return [...rows.values()];
}

/** Totals straight from the machine's per-kind groups (every process). */
/** The machine reported its vitals but could not list processes (ps timed out under load). */
export const processesUnavailable = (snap: MachineResourceSnapshot | undefined) => !!snap && snap.sample.processCount === undefined;

export function machineTotals(snap: MachineResourceSnapshot): Usage {
  const t = zero();
  for (const g of snap.groups) add(t, g.cpu, g.rss, g.processCount);
  return t;
}

export type Freshness = "cold" | "live" | "stale" | "offline";

export function freshness(m: ResourceMachine, now: number): Freshness {
  if (!m.snapshot || m.receivedAt === undefined) return m.online ? "cold" : "offline";
  if (!m.online) return "offline";
  // A freshly received report can still carry an old (or future-dated) sample.
  const at = m.snapshot.sample.at;
  return now - m.receivedAt > RESOURCE_STALE_MS || now - at > RESOURCE_STALE_MS || at > now + 30_000 ? "stale" : "live";
}

export const memoryUsed = (p: ResourcePoint) => Math.max(0, p.memoryTotal - p.memoryAvailable);
export const memoryUsedPct = (p: ResourcePoint) => (p.memoryTotal > 0 ? (memoryUsed(p) / p.memoryTotal) * 100 : undefined);
export const loadPerCore = (p: ResourcePoint) => p.load1 / Math.max(1, p.logicalCpus);

// ---- grouping ----

export type GroupBy = "session" | "project" | "kind" | "machine";
export type SortBy = "name" | "state" | "cpu" | "memory" | "procs" | "idle";
export type SortDir = "asc" | "desc";
export type Sort = { by: SortBy; dir: SortDir };
/** The direction a column sorts in when first picked: biggest and most idle first, names and states in order. */
export const DEFAULT_SORT_DIR: Record<SortBy, SortDir> = { name: "asc", state: "asc", cpu: "desc", memory: "desc", procs: "desc", idle: "desc" };
const STATE_ORDER = ["working", "needs_input", "idle", "hibernated", "dead"];

export type TableRow = {
  key: string;
  label: string;
  sublabel?: string;
  type: AttributionRow["type"] | "project" | "kind" | "machine";
  deviceIds: string[];
  session?: ResourceSession;
  sharedWith?: ResourceSession[];
  sharedWithIds?: string[];
  usage: Usage;
  byKind: Partial<Record<ResourceKind, Usage>>;
  processes: ResourceProcess[];
  remainder?: Usage;
  /** A session with no measured processes (parked, or not seen in the sample): no usage to show. */
  unmeasured?: "no_processes" | "list_unavailable";
  children?: TableRow[];
  lastActiveAt?: number;
};

export function projectName(path?: string): string {
  if (!path) return "No project";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

function merge(into: TableRow, r: TableRow) {
  add(into.usage, r.usage.cpu, r.usage.rss, r.usage.count);
  for (const [k, v] of Object.entries(r.byKind) as [ResourceKind, Usage][]) add((into.byKind[k] ??= zero()), v.cpu, v.rss, v.count);
  into.processes.push(...r.processes);
  for (const d of r.deviceIds) if (!into.deviceIds.includes(d)) into.deviceIds.push(d);
  (into.children ??= []).push(r);
  if (r.lastActiveAt && (!into.lastActiveAt || r.lastActiveAt > into.lastActiveAt)) into.lastActiveAt = r.lastActiveAt;
}

export function buildRows(
  machines: ResourceMachine[],
  sessions: ResourceSession[],
  groupBy: GroupBy,
): TableRow[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const base: TableRow[] = [];
  for (const m of machines) {
    if (!m.snapshot) continue;
    for (const a of attribute(m.deviceId, m.snapshot)) {
      const session = a.sessionId ? byId.get(a.sessionId) : undefined;
      const shared = a.sharedWith?.map((id) => byId.get(id)).filter((s): s is ResourceSession => !!s);
      base.push({
        key: a.key,
        type: a.type,
        label: a.type === "session"
          ? session?.title ?? `Session ${a.sessionId!.slice(0, 7)} (not in your fleet)`
          : a.type === "shared"
            ? a.processes.map((p) => p.name).filter((n, i, all) => all.indexOf(n) === i).slice(0, 2).join(", ")
            : "Not attributed to a session",
        sublabel: a.type === "shared"
          ? `shared by ${a.sharedWith!.length} sessions, counted once`
          : a.type === "unattributed"
            ? `${machines.length > 1 ? `${m.name} · ` : ""}apps, system and tools whose owner is unknown`
            : undefined,
        deviceIds: [m.deviceId],
        session,
        sharedWith: shared,
        sharedWithIds: a.sharedWith,
        usage: { ...a.usage },
        byKind: a.byKind,
        processes: a.processes,
        remainder: a.remainder,
        lastActiveAt: session?.lastActiveAt,
      });
    }
  }
  // Sessions the samples list no processes for still need a row, or a parked one could not be resumed here.
  const shown = new Set(base.filter((r) => r.session).map((r) => r.session!.sessionId));
  const reporting = new Set(machines.filter((m) => m.snapshot).map((m) => m.deviceId));
  for (const s of sessions) {
    if (shown.has(s.sessionId) || !s.deviceId || !reporting.has(s.deviceId) || s.state === "dead") continue;
    base.push({
      key: `${s.deviceId}:s:${s.sessionId}`, type: "session", label: s.title,
      deviceIds: [s.deviceId], session: s, usage: zero(), byKind: {}, processes: [], lastActiveAt: s.lastActiveAt,
      unmeasured: processesUnavailable(machines.find((m) => m.deviceId === s.deviceId)?.snapshot) ? "list_unavailable" : "no_processes",
    });
  }
  if (groupBy === "session") return base;
  const groups = new Map<string, TableRow>();
  for (const r of base) {
    let key: string; let label: string; let type: TableRow["type"];
    if (groupBy === "machine") {
      key = `m:${r.deviceIds[0]}`; type = "machine";
      label = machines.find((m) => m.deviceId === r.deviceIds[0])?.name ?? r.deviceIds[0];
    } else if (groupBy === "project") {
      if (r.type !== "session") { groups.set(r.key, r); continue; }
      key = `p:${r.session?.projectPath ?? ""}`; type = "project"; label = projectName(r.session?.projectPath);
    } else {
      // kind: split each row's usage by process kind
      for (const [k, v] of Object.entries(r.byKind) as [ResourceKind, Usage][]) {
        const g = groups.get(`k:${k}`) ?? { key: `k:${k}`, label: KIND_LABEL[k], type: "kind" as const, deviceIds: [], usage: zero(), byKind: {}, processes: [], children: [] };
        groups.set(`k:${k}`, g);
        add(g.usage, v.cpu, v.rss, v.count);
        add((g.byKind[k] ??= zero()), v.cpu, v.rss, v.count);
        g.processes.push(...r.processes.filter((p) => p.kind === k));
        for (const d of r.deviceIds) if (!g.deviceIds.includes(d)) g.deviceIds.push(d);
        g.children!.push({ ...r, key: `${r.key}:${k}`, usage: { ...v }, byKind: { [k]: v }, processes: r.processes.filter((p) => p.kind === k), remainder: undefined });
      }
      continue;
    }
    const g = groups.get(key) ?? { key, label, type, deviceIds: [], usage: zero(), byKind: {}, processes: [] };
    groups.set(key, g);
    merge(g, r);
  }
  return [...groups.values()];
}

export function sortRows(rows: TableRow[], sort: Sort): TableRow[] {
  const { by, dir } = sort;
  const usage = by === "cpu" || by === "memory" || by === "procs";
  const key = (r: TableRow): number | string | undefined =>
    by === "name" ? r.label
    : by === "state" ? (r.session ? STATE_ORDER.indexOf(r.session.state) : undefined)
    : by === "cpu" ? r.usage.cpu
    : by === "memory" ? r.usage.rss
    : by === "procs" ? r.usage.count
    : r.lastActiveAt === undefined ? undefined : -r.lastActiveAt;
  const cmp = (a: TableRow, b: TableRow) => {
    // The unattributed row always sits last: it is context, not a candidate.
    const tail = (r: TableRow) => (r.type === "unattributed" ? 1 : 0);
    if (tail(a) !== tail(b)) return tail(a) - tail(b);
    if (usage && !!a.unmeasured !== !!b.unmeasured) return Number(!!a.unmeasured) - Number(!!b.unmeasured);
    const ka = key(a), kb = key(b);
    if ((ka === undefined) !== (kb === undefined)) return ka === undefined ? 1 : -1;
    const c = typeof ka === "string" ? ka.localeCompare(kb as string) : ((ka as number) ?? 0) - ((kb as number) ?? 0);
    return (dir === "asc" ? c : -c) || a.label.localeCompare(b.label);
  };
  return [...rows].sort(cmp).map((r) => (r.children ? { ...r, children: sortRows(r.children, sort) } : r));
}

// ---- formatting ----

export function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "n/a";
  const gb = bytes / 1024 ** 3;
  if (gb >= 100) return `${gb.toFixed(0)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return mb >= 1 ? `${mb.toFixed(0)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Process CPU, where one core is 100%. */
export function fmtCpu(cpu: number | undefined): string {
  if (cpu === undefined || !Number.isFinite(cpu)) return "n/a";
  return cpu >= 100 ? `${(cpu / 100).toFixed(1)} cores` : `${cpu.toFixed(cpu < 10 ? 1 : 0)}%`;
}

export function fmtRate(bps: number | undefined): string {
  return bps === undefined ? "n/a" : `${fmtBytes(bps)}/s`;
}

export function fmtAgo(at: number | undefined, now: number): string {
  if (at === undefined) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function fmtRange(lo: number | undefined, hi: number | undefined, f: (n: number) => string): string {
  if (lo === undefined && hi === undefined) return "unknown";
  if (lo === undefined || hi === undefined || Math.abs(hi - lo) < 1) return f((lo ?? hi)!);
  return `${f(lo)} – ${f(hi)}`;
}
