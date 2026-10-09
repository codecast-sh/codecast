// How work flows through the org (the map's This week): each role's week as a
// daily series, the weight of every edge on the map, and what a change to a
// limit or a share of load would have done to the same week. Pure: it reads
// org.tree and org.health and nothing else, so the map, the volume table and
// the what-if read one set of numbers.
import { DEFAULT_ROLE_CAPS } from "@codecast/shared/contracts/orgCapacity";
import { areaRows, type AreaRow } from "./staffingModel";
import type { OrgHealth, OrgRoleHealth } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";
import { roleNodeId } from "./orgLayout";

const D = 86_400_000;
export const FLOW_DAYS = 7;

/** The week's UTC days, oldest first, ending today (the server's utcDay). */
export function flowDays(now: number): string[] {
  return Array.from({ length: FLOW_DAYS }, (_, i) => new Date(now - (FLOW_DAYS - 1 - i) * D).toISOString().slice(0, 10));
}

const series = (byDay: Record<string, number> | undefined, days: string[]): number[] => days.map((d) => byDay?.[d] ?? 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export type RoleFlow = AreaRow & {
  health: OrgRoleHealth | null;
  /** Work that reached the seat (wakes), work it closed, decisions routed to it: one number per day. */
  wakes: number[];
  done: number[];
  decisions: number[];
  wakesTotal: number;
  doneTotal: number;
  decisionsTotal: number;
  /** Its daily wake limit, and the days this week it reached it. */
  cap: number;
  daysAtCap: number;
  /** Its average day against its limit: 1 = every day at the limit. */
  loadRatio: number;
  /** Sessions working under it now, and stalls it has to chase. */
  liveHands: number;
  stalls: number;
};

/** Every live role's week, busiest first. A role health has not read yet
 *  still has a row, at zero, so the table never drops a seat the chart shows. */
export function roleFlows(tree: OrgTree | null, health: OrgHealth | null, now: number): RoleFlow[] {
  const days = flowDays(now);
  const byRole = new Map((health?.roles ?? []).map((r) => [r.role_id, r]));
  return areaRows(tree, health).map((row) => {
    const h = byRole.get(row.role._id) ?? null;
    // A server older than the daily series still says the week's totals:
    // the series spreads nothing it does not know, so it stays empty.
    const wakes = series(h?.spend.wakes_by_day, days);
    const done = series(h?.flow.done_by_day, days);
    const decisions = series(h?.flow.decisions_by_day, days);
    const cap = h?.spend.wakes_cap ?? row.role.caps?.wakes_per_day ?? DEFAULT_ROLE_CAPS.wakes_per_day;
    const wakesTotal = h?.spend.wakes_by_day ? sum(wakes) : Math.round((h?.load.items_per_day ?? 0) * FLOW_DAYS);
    return {
      ...row,
      health: h,
      wakes, done, decisions,
      wakesTotal,
      doneTotal: h?.flow.done_7d ?? sum(done),
      decisionsTotal: h?.flow.decisions_7d ?? sum(decisions),
      cap,
      daysAtCap: h?.spend.cap_hits_7d ?? wakes.filter((w) => w >= cap).length,
      loadRatio: cap > 0 ? wakesTotal / FLOW_DAYS / cap : 0,
      liveHands: h?.load.live_hands ?? 0,
      stalls: h?.load.open_stalls ?? 0,
    };
  }).sort((a, b) => b.wakesTotal - a.wakesTotal || b.doneTotal - a.doneTotal || a.role.name.localeCompare(b.role.name));
}

export type CompanyFlow = { wakes: number[]; done: number[]; decisions: number[]; stalls: number; liveHands: number; atCap: number };

/** The company's week: the roles' series added day by day. */
export function companyFlow(flows: RoleFlow[]): CompanyFlow {
  const add = (pick: (f: RoleFlow) => number[]) => Array.from({ length: FLOW_DAYS }, (_, i) => sum(flows.map((f) => pick(f)[i] ?? 0)));
  return {
    wakes: add((f) => f.wakes),
    done: add((f) => f.done),
    decisions: add((f) => f.decisions),
    stalls: sum(flows.map((f) => f.stalls)),
    liveHands: sum(flows.map((f) => f.liveHands)),
    atCap: flows.filter((f) => f.daysAtCap > 0).length,
  };
}

/** A line of work between two cards on the map, with the week's count. */
export type FlowEdgeWeight = { n: number; ratio: number; status: AreaRow["status"]; color: string; atLimit: boolean };
export type FlowSend = { id: string; source: string; target: string; n: number };
export type FlowMap = {
  /** The reporting edge into a role, keyed by the role's node id: what reached it this week. */
  into: Record<string, FlowEdgeWeight>;
  /** Work one role sent another this week (sends_7d), drawn across the tree. */
  sends: FlowSend[];
  /** The busiest edge, which every width scales against. */
  max: number;
};

export function flowMap(flows: RoleFlow[]): FlowMap {
  const into: FlowMap["into"] = {};
  const ids = new Set(flows.map((f) => f.role._id));
  const sends: FlowSend[] = [];
  for (const f of flows) {
    into[f.nodeId] = { n: f.wakesTotal, ratio: f.loadRatio, status: f.status, color: f.color, atLimit: f.daysAtCap > 0 };
    for (const t of f.health?.flow.sends_7d.to ?? []) {
      if (!ids.has(t.role_id) || t.n <= 0) continue;
      sends.push({ id: `send:${f.role._id}->${t.role_id}`, source: f.nodeId, target: roleNodeId(t.role_id), n: t.n });
    }
  }
  const max = Math.max(1, ...Object.values(into).map((e) => e.n), ...sends.map((s) => s.n));
  return { into, sends, max };
}

// ---------------------------------------------------------------- what if

export type CapProjection = { cap: number; daysAtCap: number; unknownDays: number; heldAtLeast: number; headroom: number };

/**
 * The same week under another daily limit. A day the seat sat at its limit
 * held the rest, and held wakes are not counted, so a higher limit cannot say
 * whether those days would have reached it too: they are `unknownDays`, said
 * apart, never folded into a count that would flatter the change.
 */
export function projectCap(f: RoleFlow, cap: number): CapProjection {
  const raised = cap > f.cap;
  const unknownDays = raised ? f.wakes.filter((w) => w >= f.cap).length : 0;
  return {
    cap,
    daysAtCap: f.wakes.filter((w) => w >= cap).length,
    unknownDays,
    heldAtLeast: f.wakes.reduce((n, w) => n + Math.max(0, w - cap), 0),
    headroom: cap - Math.max(0, ...f.wakes),
  };
}

export type MoveProjection = {
  share: number;
  /** Wakes a day each side would have carried, and the days each would have sat at its limit. */
  from: number[];
  to: number[];
  fromDaysAtCap: number;
  toDaysAtCap: number;
  moved: number;
};

/** The same week with `share` of one role's load handed to another. */
export function projectMove(from: RoleFlow, to: RoleFlow, share: number): MoveProjection {
  const s = Math.max(0, Math.min(1, share));
  const a = from.wakes.map((w) => Math.round(w * (1 - s)));
  const b = to.wakes.map((w, i) => w + Math.round(from.wakes[i] * s));
  return {
    share: s,
    from: a,
    to: b,
    fromDaysAtCap: a.filter((w) => w >= from.cap).length,
    toDaysAtCap: b.filter((w) => w >= to.cap).length,
    moved: sum(from.wakes) - sum(a),
  };
}

/** The line handed to the Head of People when a person wants a move proposed. */
export function moveAsk(from: RoleFlow, to: RoleFlow, p: MoveProjection): string {
  const pct = Math.round(p.share * 100);
  return `Propose moving about ${pct}% of ${from.role.name} (@${from.role.handle})'s work to ${to.role.name} (@${to.role.handle}). Over the last week that is about ${p.moved} of the ${from.wakesTotal} pieces of work that reached it; ${from.role.name} would have sat at its limit on ${p.fromDaysAtCap} days instead of ${from.daysAtCap}, and ${to.role.name} on ${p.toDaysAtCap} instead of ${to.daysAtCap}. Say which projects or plans you would move, and why.`;
}
