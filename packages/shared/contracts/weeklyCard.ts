// The weekly card: a person's week with coding agents (Monday to Sunday in
// their own time zone), as numbers a stranger can read at a glance. The
// server builds it from the person's sessions, devices and token counters;
// the owner previews it in the app and may publish it at /share/card/<token>,
// whose page and social image draw the same stats. Pure, so the week math is
// tested without a database.
import { wallClock, wallTimeIn } from "../time";
import { agentDisplayName } from "./agentClients";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A session credits at most this much wall time: a terminal left open is not work (lib/activityDaily CAP). */
export const SESSION_CREDIT_CAP_MS = 8 * HOUR;
/** A session open longer than this was resumed across days, not worked through; it stays out of "longest session". */
export const LONGEST_SESSION_MAX_MS = 24 * HOUR;
/** Token counters exist from this UTC day on (user_usage_daily started 2026-09-13); a week before it is partial. */
export const TOKEN_HISTORY_START = Date.UTC(2026, 8, 13);

export type WeekWhich = "last" | "current";

/** The feature flag: Codecast staff only until the card is reviewed. Every reader (server and app) asks this. */
export function weeklyCardAllowed(user: { staff?: boolean } | null | undefined): boolean {
  return user?.staff === true;
}

export type WeekBounds = {
  /** The local Monday 00:00 the week starts at. */
  start: number;
  /** The next local Monday 00:00. */
  end: number;
  /** The Monday as "YYYY-MM-DD", the card's identity for the week. */
  key: string;
  /** The 8 local midnights from start to end; a daylight saving week has a 23 or 25 hour day. */
  days: number[];
};

const pad = (n: number) => String(n).padStart(2, "0");

/** The Monday-to-Sunday week in `tz` that holds `now` ("current") or the one before it ("last"). */
export function weekBounds(now: number, tz: string, which: WeekWhich): WeekBounds {
  const w = wallClock(now, tz);
  const today = Date.UTC(w.year, w.month - 1, w.day);
  const sinceMonday = (new Date(today).getUTCDay() + 6) % 7;
  const monday = today - (sinceMonday + (which === "last" ? 7 : 0)) * DAY;
  const days = Array.from({ length: 8 }, (_, i) => wallTimeIn(monday + i * DAY, tz));
  const m = new Date(monday);
  return { start: days[0], end: days[7], key: `${m.getUTCFullYear()}-${pad(m.getUTCMonth() + 1)}-${pad(m.getUTCDate())}`, days };
}

/** One session as the card needs it: times, agent, machine, project. Never a title or a prompt. */
export type WeekCardSession = {
  started_at: number;
  updated_at: number;
  agent_type: string;
  device_id?: string | null;
  /** The project's folder name, or null. Only shown when the owner turns projects on. */
  project?: string | null;
  /** Private sessions count toward the numbers but never lend their project name. */
  private?: boolean;
  /** A standing role session that lives for days; it stays out of "longest session" (as does any session open past a day). */
  persistent?: boolean;
};

export type DeviceKind = "mac" | "linux" | "windows" | "cloud";
export type WeekCardDevice = { device_id: string; kind: DeviceKind };

/** A device row → the kind the card names it by. Never the hostname or label. */
export function deviceKindOf(d: { platform?: string | null; is_remote?: boolean | null; cloud_host?: unknown }): DeviceKind {
  if (d.is_remote || d.cloud_host) return "cloud";
  const p = (d.platform ?? "").toLowerCase();
  if (p.startsWith("darwin") || p.startsWith("mac")) return "mac";
  if (p.startsWith("win")) return "windows";
  return "linux";
}

export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = { mac: "Mac", linux: "Linux", windows: "Windows", cloud: "cloud host" };

/** The card's name for an agent: the product people know it by. */
export function weekCardAgentName(agentType: string): string {
  return agentType === "claude_code" ? "Claude Code" : agentDisplayName(agentType);
}

export type WeekCardDay = { date: number; hours: number; sessions: number };

export type WeekCardStats = {
  week_key: string;
  week_start: number;
  week_end: number;
  tz: string;
  /** The week was still running when this was built. */
  partial: boolean;
  sessions: number;
  active_days: number;
  /** Hours with at least one agent working, overlaps counted once. */
  agent_hours: number;
  agents: Array<{ name: string; sessions: number }>;
  machines: { count: number; kinds: Array<{ kind: DeviceKind; count: number }> };
  days: WeekCardDay[];
  longest_session_ms: number;
  /** Index into `days`, or -1 for an empty week. */
  busiest_day: number;
  /** Top projects by sessions, from sessions that are not private. Shown only when the owner turns them on. */
  projects: Array<{ name: string; sessions: number }>;
  /** Tokens across the week, or null when the counters do not cover all of it. */
  tokens: number | null;
};

type Span = [number, number];

/** Merge overlapping spans; the input is sorted by start. */
function union(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function overlap(spans: Span[], from: number, to: number): number {
  let t = 0;
  for (const [a, b] of spans) t += Math.max(0, Math.min(b, to) - Math.max(a, from));
  return t;
}

const roundHours = (ms: number) => Math.round((ms / HOUR) * 10) / 10;

function topCounts(names: Array<string | null | undefined>, limit = Infinity): Array<{ name: string; sessions: number }> {
  const counts = new Map<string, number>();
  for (const n of names) if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([name, sessions]) => ({ name, sessions }));
}

/**
 * The card for one week. A session belongs to the week when its credited span
 * ([updated_at minus at most 8h, updated_at]) touches it, and to each day that
 * span touches. `tokenHours` are hourly token buckets as [hour start, tokens].
 */
export function buildWeekCard(input: {
  bounds: WeekBounds;
  tz: string;
  now: number;
  sessions: WeekCardSession[];
  devices: WeekCardDevice[];
  tokenHours?: Array<[number, number]>;
}): WeekCardStats {
  const { bounds, tz, now } = input;
  const { start, end, days } = bounds;
  const credited = input.sessions
    .map((s) => {
      const upd = Math.max(s.updated_at, s.started_at);
      return { s, span: [Math.max(s.started_at, upd - SESSION_CREDIT_CAP_MS), upd] as Span };
    })
    .filter(({ span }) => span[1] >= start && span[0] < end);

  const spans = union(credited.map(({ span }) => [Math.max(span[0], start), Math.min(Math.max(span[1], span[0] + 60_000), end)] as Span).sort((a, b) => a[0] - b[0]));
  const dayRows: WeekCardDay[] = days.slice(0, 7).map((d, i) => ({
    date: d,
    hours: roundHours(overlap(spans, d, days[i + 1])),
    sessions: credited.filter(({ span }) => span[1] >= d && span[0] < days[i + 1]).length,
  }));

  let busiest = -1;
  dayRows.forEach((d, i) => {
    if (d.hours > 0 && (busiest < 0 || d.hours > dayRows[busiest].hours)) busiest = i;
  });

  const longest = credited
    .filter(({ s }) => !s.persistent && s.updated_at - s.started_at <= LONGEST_SESSION_MAX_MS)
    .reduce((m, { s }) => Math.max(m, Math.min(s.updated_at, end) - Math.max(s.started_at, start)), 0);

  const deviceKind = new Map(input.devices.map((d) => [d.device_id, d.kind]));
  const usedDevices = [...new Set(credited.map(({ s }) => s.device_id).filter((d): d is string => !!d))];
  const kinds = topCounts(usedDevices.map((d) => deviceKind.get(d) ?? "linux")).map((k) => ({ kind: k.name as DeviceKind, count: k.sessions }));

  const tokensComplete = start >= TOKEN_HISTORY_START && input.tokenHours !== undefined;
  const tokens = tokensComplete ? input.tokenHours!.reduce((t, [h, n]) => (h >= start && h < end ? t + n : t), 0) : null;

  return {
    week_key: bounds.key,
    week_start: start,
    week_end: end,
    tz,
    partial: now < end,
    sessions: credited.length,
    active_days: dayRows.filter((d) => d.hours > 0).length,
    agent_hours: roundHours(overlap(spans, start, end)),
    agents: topCounts(credited.map(({ s }) => weekCardAgentName(s.agent_type))),
    machines: { count: usedDevices.length, kinds },
    days: dayRows,
    longest_session_ms: Math.max(0, longest),
    busiest_day: busiest,
    projects: topCounts(credited.filter(({ s }) => !s.private).map(({ s }) => s.project), 5),
    tokens,
  };
}

/** What a stranger sees: the stats with the owner's optional parts removed unless they turned them on. */
export function publicWeekCard(stats: WeekCardStats, opts: { show_projects?: boolean; show_tokens?: boolean }): WeekCardStats {
  return { ...stats, projects: opts.show_projects ? stats.projects : [], tokens: opts.show_tokens ? stats.tokens : null };
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 26 – Nov 1" for the week, read in its own zone. */
export function weekRangeLabel(stats: Pick<WeekCardStats, "week_start" | "week_end" | "tz">): string {
  const a = wallClock(stats.week_start, stats.tz);
  const b = wallClock(stats.week_end - 1, stats.tz);
  const left = `${SHORT_MONTHS[a.month - 1]} ${a.day}`;
  const right = a.month === b.month ? String(b.day) : `${SHORT_MONTHS[b.month - 1]} ${b.day}`;
  return `${left} – ${right}`;
}

/** "3h 20m" / "45m". */
export function formatSpan(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** "1.2M", "48k", "950". */
export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}

export const WEEK_DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The footer link every published card carries. */
export const WEEK_CARD_SITE_URL = "https://codecast.sh/?utm_source=scorecard&utm_medium=share&utm_campaign=weekly-card";
export const WEEK_CARD_INSTALL = "curl -fsSL codecast.sh/i/scorecard | sh";
