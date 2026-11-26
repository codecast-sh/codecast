// What /priorities draws (components/priorities), derived on read from the
// store's priority rows (their links and plans come from convex
// priorities.list), the history answer (typing per day, today's unassigned
// sessions) and the inbox's live session states. Nothing here is stored:
// next actions, the bracket rail, momentum, today's shares, waiting on you.
import type { PriorityHistory, PriorityLinkedSession, PriorityPlanRef, PriorityRow, PrioritySessionState, PriorityStep } from "@codecast/shared/contracts/priorities";
import { asksPerson, isClosedSession, nextActionOf, orderSessions, type NextAction } from "@codecast/shared/contracts/priorityDerive";
import type { SessionStatus } from "./sessionStatus";

export const LIST_DAYS = 10;
const DAY = 86_400_000;
/** A priority this old with no critical landing in this many days reads Stalled. */
const STALL_DAYS = 5;

/** "2026-11-25" for a timestamp, in the viewer's local calendar. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The last `n` local days, oldest first, today last. */
export function lastDays(n: number, now: number): string[] {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => localDayKey(d.getTime() - (n - 1 - i) * DAY));
}

/** A history series re-keyed onto `days`. */
export function alignCounts(history: PriorityHistory | undefined, days: readonly string[], counts: readonly number[] | undefined): number[] {
  if (!history || !counts) return days.map(() => 0);
  return days.map((d) => {
    const i = history.days.indexOf(d);
    return i === -1 ? 0 : counts[i] ?? 0;
  });
}

/** "just now", "12m", "3h", "2d". */
export function ago(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The inbox's states (lib/sessionStatus) in the list's words. */
export function stateOfStatus(s: SessionStatus): PrioritySessionState {
  switch (s) {
    case "needs_you": case "error": return "needs_you";
    case "working": case "starting": return "working";
    case "dormant": return "dormant";
    case "done": return "done";
    case "killed": return "killed";
    default: return "idle";
  }
}

export const STATE_WORD: Record<PrioritySessionState, string> = {
  needs_you: "Needs you", working: "Working", dormant: "Dormant", idle: "Idle", done: "Done", killed: "Closed",
};

const demote = (s: Pick<PriorityLinkedSession, "mine">, state: PrioritySessionState): PrioritySessionState => (state === "needs_you" && s.mine === false ? "idle" : state);

/** A linked session as the list draws it: the inbox's live state over the server's, where it opens, and today's typing. */
export type SessionLine = PriorityLinkedSession & { href: string; today: number };

export type MilestoneModel = {
  key: string;
  tier: PriorityStep["tier"];
  done: boolean;
  step: PriorityStep;
  /** Best first (orderSessions). */
  sessions: SessionLine[];
  /** Linked sessions the row did not carry. */
  more: number;
  /** Still open, every task it names done (the server's looks_done). */
  looksDone: boolean;
  /** A correction on it waits for the next pass. */
  correctionPending: boolean;
  plan: PriorityPlanRef | null;
  partOf: PriorityPlanRef[];
  tasks: string[];
  /** "owner/repo#N" refs. */
  prs: string[];
  today: number;
};

export type PriorityModel = {
  row: PriorityRow;
  milestones: MilestoneModel[];
  plan: PriorityPlanRef | null;
  /** Typing per day over the shown days, and which of them a critical milestone landed on. */
  counts: number[];
  landed: boolean[];
  today: number;
  landed10: number;
  /** Days since a critical milestone last landed; null when none has. */
  lastLandedDays: number | null;
  /** Open critical work with no landing in STALL_DAYS or more, on a priority at least that old; else null. */
  stalledDays: number | null;
  action: NextAction<MilestoneModel> | null;
  /** One session working at least half the open critical milestones (two or more): it heads a bracket over the lines from its first to its last. */
  rail: { session: SessionLine; keys: string[] } | null;
};

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The session covering most of a priority's open critical milestones, and the lines its bracket spans. */
export function railOf(milestones: readonly MilestoneModel[]): PriorityModel["rail"] {
  const open = milestones.filter((m) => m.tier === "critical" && !m.done);
  if (open.length < 2) return null;
  const reach = new Map<string, { s: SessionLine; at: number[] }>();
  open.forEach((m, i) => {
    for (const s of m.sessions) {
      if (isClosedSession(s)) continue;
      const r = reach.get(s.conversation_id) ?? { s, at: [] };
      r.at.push(i);
      reach.set(s.conversation_id, r);
    }
  });
  const best = [...reach.values()]
    .filter((r) => r.at.length >= 2 && r.at.length * 2 >= open.length)
    .sort((a, b) => Number(a.s.workflow) - Number(b.s.workflow) || b.at.length - a.at.length)[0];
  if (!best) return null;
  return { session: best.s, keys: open.slice(best.at[0], best.at[best.at.length - 1] + 1).map((m) => m.key) };
}

/**
 * Every priority's model. `live` answers the inbox's verdict for a session
 * the store holds (by conversation id); the server's doc-only state stands
 * for the rest.
 */
export function buildModels(
  rows: readonly PriorityRow[],
  history: PriorityHistory | undefined,
  live: (conversationId: string) => PrioritySessionState | undefined,
  days: readonly string[],
  now: number,
): PriorityModel[] {
  const todayKey = localDayKey(now);
  const todayAt = history?.days.indexOf(todayKey) ?? -1;
  const typedToday = (shortId: string) => (todayAt === -1 ? 0 : history?.sessions?.[shortId]?.[todayAt] ?? 0);
  const lanes = new Map((history?.lanes ?? []).map((l) => [l.short_id ?? l.key, l]));
  const daySet = new Set(days);
  return rows.map((row) => {
    const links = new Map((row.links ?? []).map((l) => [l.key, l]));
    // Reads never return a dropped milestone; a row cached before that rule is held to it here.
    const milestones = row.steps.filter((step) => !step.dropped).map((step): MilestoneModel => {
      const l = links.get(step.key);
      const sessions = orderSessions((l?.sessions ?? []).map((s) => ({
        ...s,
        // Another's session never asks the viewer anything, whatever the inbox says of it.
        state: demote(s, live(s.conversation_id) ?? s.state),
        href: `/conversation/${s.conversation_id}`,
        today: typedToday(s.short_id),
      })));
      return {
        key: step.key,
        tier: step.tier,
        done: step.done,
        step,
        sessions,
        more: l?.sessions_more ?? 0,
        looksDone: !!l?.looks_done && !step.done,
        correctionPending: !!l?.correction_pending,
        plan: l?.plan ?? null,
        partOf: l?.part_of ?? [],
        tasks: step.refs.filter((r) => r.kind === "task").map((r) => r.id),
        prs: step.refs.filter((r) => r.kind === "pr").map((r) => r.id),
        today: sessions.reduce((n, s) => n + s.today, 0),
      };
    });
    const counts = alignCounts(history, days, lanes.get(row.short_id)?.counts);
    const critical = row.steps.filter((s) => s.tier === "critical" && s.done && s.done_at).map((s) => s.done_at!);
    const landedDays = new Set(critical.map(localDayKey));
    const last = critical.length ? Math.max(...critical) : null;
    const quiet = Math.floor((now - (last ?? row.first_seen_at)) / DAY);
    const openCritical = row.steps.some((s) => s.tier === "critical" && !s.done);
    const stalled = row.status === "active" && openCritical && now - row.first_seen_at >= STALL_DAYS * DAY && quiet >= STALL_DAYS;
    return {
      row,
      milestones,
      plan: row.plan ?? null,
      counts,
      landed: days.map((d) => landedDays.has(d)),
      today: counts[days.indexOf(todayKey)] ?? 0,
      landed10: critical.filter((t) => daySet.has(localDayKey(t))).length,
      lastLandedDays: last == null ? null : Math.round((startOfDay(now) - startOfDay(last)) / DAY),
      stalledDays: stalled ? quiet : null,
      // A teammate's priority offers no action: starting, resuming and answering its work is theirs to do.
      action: row.mine && row.status === "active" ? nextActionOf(milestones) : null,
      rail: row.status === "active" ? railOf(milestones) : null,
    };
  });
}

/** Something waiting on the viewer: a session asking on an open milestone of one of their active priorities. */
export type WaitingItem = { key: string; priority: string; rank: number | null; milestone: string; session: SessionLine };

/** Every session asking the viewer, by rank, critical milestones before polish, each once. */
export function waitingOf(models: readonly PriorityModel[]): WaitingItem[] {
  const out: WaitingItem[] = [];
  const seen = new Set<string>();
  const mine = models.filter((m) => m.row.mine && m.row.status === "active").sort((a, b) => (a.row.rank ?? 1e9) - (b.row.rank ?? 1e9));
  for (const pm of mine) {
    const open = pm.milestones.filter((m) => !m.done).sort((a, b) => Number(a.tier === "polish") - Number(b.tier === "polish"));
    for (const m of open) {
      for (const s of m.sessions.filter(asksPerson).sort((a, b) => b.last_active_at - a.last_active_at)) {
        if (seen.has(s.conversation_id)) continue;
        seen.add(s.conversation_id);
        out.push({ key: `${pm.row.short_id}:${m.key}:${s.short_id}`, priority: pm.row.short_id, rank: pm.row.rank, milestone: m.step.title, session: s });
      }
    }
  }
  return out;
}

// ── Today and the ten days ───────────────────────────────────────────────

export type TodaySegment = { key: string; title: string; count: number; tone: "top" | "rest" | "none" };
export type TodayShare = { label: string; count: number; pct: number };

/** Whole percentages that add up to exactly 100 (largest remainder). */
export function shares(values: readonly number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((a, b) => a + b, 0);
  for (const [, i] of raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

/**
 * Where today's messages went, among the viewer's own lanes: each priority in
 * rank order (the top three strong), then no priority. `parts` are the
 * shares in words, #1 #2 #3 rest none, adding up to 100.
 */
export function todayOf(history: PriorityHistory | undefined, rows: readonly PriorityRow[], now: number): {
  segments: TodaySegment[];
  parts: TodayShare[];
  total: number;
  topPct: number;
} {
  const at = history?.days.indexOf(localDayKey(now)) ?? -1;
  if (!history || at === -1) return { segments: [], parts: [], total: 0, topPct: 0 };
  const rank = new Map(rows.filter((r) => r.mine && r.status === "active").map((r) => [r.short_id, r.rank]));
  const segs = history.lanes
    .filter((l) => !l.owner && (l.counts[at] ?? 0) > 0)
    .map((l) => {
      const r = l.short_id ? rank.get(l.short_id) ?? null : null;
      const tone: TodaySegment["tone"] = !l.short_id ? "none" : r != null && r <= 3 ? "top" : "rest";
      return { key: l.key, title: l.short_id ? `${r != null ? `#${r} ` : ""}${l.title}` : "No priority", count: l.counts[at] ?? 0, tone, r, order: !l.short_id ? 1e9 : r ?? 1e6 };
    })
    .sort((a, b) => a.order - b.order);
  const byRank = (n: number) => segs.filter((s) => s.r === n).reduce((c, s) => c + s.count, 0);
  const top = [byRank(1), byRank(2), byRank(3)];
  const rest = segs.filter((s) => s.tone !== "none" && !(s.r != null && s.r <= 3)).reduce((c, s) => c + s.count, 0);
  const none = segs.filter((s) => s.tone === "none").reduce((c, s) => c + s.count, 0);
  const pct = shares([...top, rest, none]);
  const parts = [
    ...top.map((count, i) => ({ label: `#${i + 1}`, count, pct: pct[i] })),
    { label: "rest", count: rest, pct: pct[3] },
    { label: "none", count: none, pct: pct[4] },
  ].filter((p) => p.count > 0);
  return {
    segments: segs.map(({ key, title, count, tone }) => ({ key, title, count, tone })),
    parts,
    total: segs.reduce((c, s) => c + s.count, 0),
    topPct: pct[0] + pct[1] + pct[2],
  };
}

export type Landed = { title: string; priority: string; rank: number | null; tier: PriorityStep["tier"] };

/** Every milestone that landed on each of `days`, critical first. */
export function landedByDay(rows: readonly PriorityRow[], days: readonly string[]): Map<string, Landed[]> {
  const out = new Map<string, Landed[]>(days.map((d) => [d, []]));
  for (const r of rows) {
    if (r.status === "merged") continue;
    for (const s of r.steps) {
      if (!s.done || !s.done_at) continue;
      out.get(localDayKey(s.done_at))?.push({ title: s.title, priority: r.title, rank: r.status === "active" ? r.rank : null, tier: s.tier });
    }
  }
  for (const list of out.values()) list.sort((a, b) => Number(a.tier === "polish") - Number(b.tier === "polish"));
  return out;
}

// ── Filters, layout ──────────────────────────────────────────────────────

export const SHOW_KINDS = ["sessions", "plans", "tasks", "prs", "branches", "deploys"] as const;
export type ShowKind = (typeof SHOW_KINDS)[number];
export type ListFilters = { mine: boolean; hideDone: boolean; show: Record<ShowKind, boolean> };
const DEFAULT_SHOW = "sessions,plans";

/** The rows the list draws under `f`: never a merged one; Mine keeps the viewer's, Hide done keeps the active. The page's count is their number. */
export function listedRows<T extends Pick<PriorityRow, "status" | "mine">>(rows: readonly T[], f: Pick<ListFilters, "mine" | "hideDone">): T[] {
  return rows.filter((r) => r.status !== "merged" && (!f.mine || r.mine) && (!f.hideDone || r.status === "active"));
}

/** The filters a page address carries; each default is left out of it. */
export function readFilters(params: URLSearchParams | null | undefined): ListFilters {
  const kinds = new Set((params?.get("show") ?? DEFAULT_SHOW).split(","));
  return {
    mine: params?.get("mine") !== "0",
    hideDone: params?.get("done") !== "1",
    show: Object.fromEntries(SHOW_KINDS.map((k) => [k, kinds.has(k)])) as Record<ShowKind, boolean>,
  };
}

/** The address for `f`, keeping the address's other parameters. */
export function filtersHref(f: ListFilters, params: URLSearchParams | null | undefined): string {
  const next = new URLSearchParams(params?.toString() ?? "");
  const set = (k: string, v: string | null) => (v === null ? next.delete(k) : next.set(k, v));
  set("mine", f.mine ? null : "0");
  set("done", f.hideDone ? null : "1");
  const kinds = SHOW_KINDS.filter((k) => f.show[k]).join(",");
  set("show", kinds === DEFAULT_SHOW ? null : kinds || "none");
  const qs = next.toString();
  return qs ? `/priorities?${qs}` : "/priorities";
}

export type ListLayout = "phone" | "wide";

/**
 * Under a coarse pointer (a phone, Daylight), a press area at least 44px each
 * way centred on a small control, drawn as its ::after: the look is the same
 * at every pointer. The control is the area's containing block, and nothing
 * between it and its line may clip it.
 */
export const TOUCH_AREA = "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:top-[min(0px,calc(50%-22px))] [@media(pointer:coarse)]:after:bottom-[min(0px,calc(50%-22px))] [@media(pointer:coarse)]:after:left-[min(0px,calc(50%-22px))] [@media(pointer:coarse)]:after:right-[min(0px,calc(50%-22px))] [@media(pointer:coarse)]:after:content-['']";

/** The polish link's slot in a wide row's progress column: one width on every row and on the column head, so the pips line up. */
export const POLISH_SLOT = "flex w-[5.25rem] shrink-0 justify-start";

/**
 * The one grid every priority row and the column heads share, so each column
 * sits at one x down the list (every class spelled whole: Tailwind generates
 * only what it reads). Wide: rank | title | progress | today | momentum |
 * menu, the momentum column its strip alone until the list (a container) is
 * 44rem wide. Each row is a grid of its own, so the progress column has one
 * width rather than its content's. Phone: rank | title | progress | strip | menu.
 */
export const LIST_GRID: Record<ListLayout, string> = {
  wide: "grid grid-cols-[20px_minmax(0,1fr)_11.5rem_28px_64px_24px] items-center gap-x-2 [@container(min-width:44rem)]:grid-cols-[20px_minmax(0,1fr)_12.5rem_28px_150px_24px] [@container(min-width:44rem)]:gap-x-3",
  phone: "grid grid-cols-[18px_minmax(0,1fr)_auto_auto_44px] items-center gap-x-2",
};

/**
 * The desktop grid for a list at least 520px wide, or on a touch screen at
 * least 900px wide (Daylight, 947), however narrow its sidebars leave the
 * list; a phone-sized list (~370px at 402) folds into the phone layout.
 */
export const WIDE_MIN_LIST_WIDTH = 520;
export const TABLET_QUERY = "(pointer: coarse) and (min-width: 900px)";
export const layoutForWidth = (width: number, tablet = false): ListLayout => (tablet || width >= WIDE_MIN_LIST_WIDTH ? "wide" : "phone");

/** A workflow run's sessions folded to "3 reviews · 1 run": its step words counted. */
export function runKinds(runs: readonly Pick<SessionLine, "title">[]): string {
  const kinds = new Map<string, number>();
  for (const r of runs) {
    const word = (/^([A-Z][a-z]+)\b/.exec(r.title)?.[1] ?? "run").toLowerCase();
    kinds.set(word, (kinds.get(word) ?? 0) + 1);
  }
  const plural = (w: string, n: number) => (n === 1 ? w : w.endsWith("y") ? `${w.slice(0, -1)}ies` : /(x|h|s)$/.test(w) ? `${w}es` : `${w}s`);
  return [...kinds].map(([k, n]) => `${n} ${plural(k, n)}`).join(" · ");
}
