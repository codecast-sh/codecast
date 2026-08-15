// Pure display logic for person presence (teams.getTeamMembers extensions):
// state → ring/dot styling, the hover-card presence line, and the fleet line
// derived from sessions already in the store. Kept React-free so it's
// unit-testable under bun, mirroring fleetBands.ts.
import { type InboxSession } from "../../store/inboxStore";
import { fleetBandFor, type FleetBandOpts } from "../fleetBands";

export type PresenceState = "active" | "idle" | "away" | "offline";

// Ring + dot classes per state. The ring is the always-visible signal (color
// vision aside, active/idle/away also differ by fill vs dim vs none); the
// manual "busy" status adds a red dot badge on top in the bar itself.
export const PRESENCE_META: Record<
  PresenceState,
  { ring: string; dot: string; label: string; dim: boolean }
> = {
  active: {
    ring: "ring-2 ring-emerald-400/90",
    dot: "bg-emerald-400",
    label: "Active",
    dim: false,
  },
  idle: {
    ring: "ring-2 ring-yellow-400/70",
    dot: "bg-yellow-400",
    label: "Idle",
    dim: false,
  },
  away: {
    ring: "ring-1 ring-sol-border",
    dot: "bg-sol-base01",
    label: "Away",
    dim: true,
  },
  offline: { ring: "", dot: "", label: "Offline", dim: true },
};

export function memberPresenceState(member: any): PresenceState {
  const s = member?.presence_state;
  return s === "active" || s === "idle" || s === "away" ? s : "offline";
}

const PRESENCE_ORDER: Record<PresenceState, number> = {
  active: 0,
  idle: 1,
  away: 2,
  offline: 3,
};

// Stable roster order: presence band, then name — deliberately NOT freshness
// within a band, so rows don't swap on every heartbeat.
export function compareMembersByPresence(a: any, b: any): number {
  const pa = PRESENCE_ORDER[memberPresenceState(a)];
  const pb = PRESENCE_ORDER[memberPresenceState(b)];
  if (pa !== pb) return pa - pb;
  return (a.name || a.email || "").localeCompare(b.name || b.email || "");
}

function compactDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// The hover card's one presence sentence. `now` must be a coarse clock
// (useCoarseNow), never Date.now() in render.
export function presenceLine(member: any, now: number): string {
  const state = memberPresenceState(member);
  if (state === "active") return "Active now";
  if (state === "idle") {
    const at = member.presence_input_at;
    return typeof at === "number"
      ? `Idle ${compactDuration(now - at)}`
      : "Idle";
  }
  if (state === "away") return "Away";
  const seen = member.daemon_last_seen;
  return typeof seen === "number"
    ? `Last seen ${compactDuration(now - seen)} ago`
    : "Offline";
}

// A teammate's local wall-clock, from their profile timezone. Empty when the
// timezone is missing/invalid or matches the viewer's (no news there).
export function localTimeLine(timezone: string | undefined, now: number): string {
  if (!timezone) return "";
  try {
    if (timezone === Intl.DateTimeFormat().resolvedOptions().timeZone) return "";
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    }).format(now);
  } catch {
    return "";
  }
}

export interface FleetSummary {
  working: number;
  needsYou: number;
  /** thread_state_status of the most actionable session, for the quote line. */
  topStatus: string | null;
  topSessionKey: string | null;
}

// "3 working · 1 needs input" for one member, derived from the sessions the
// store ALREADY holds (team-scoped inbox rows) — the server sends no fleet
// counts, so this is always consistent with the board/sidebar the viewer sees
// and costs nothing extra. Sessions of members outside the current team scope
// simply aren't in the store, and the card omits the line.
export function memberFleetSummary(
  sessions: InboxSession[],
  memberId: string,
  opts: FleetBandOpts,
): FleetSummary | null {
  let working = 0;
  let needsYou = 0;
  let topStatus: string | null = null;
  let topSessionKey: string | null = null;
  let sawAny = false;
  for (const s of sessions) {
    if (!s || String(s.user_id ?? "") !== memberId) continue;
    sawAny = true;
    const band = fleetBandFor(s, opts);
    if (band === "running") working++;
    else if (band === "needsYou") needsYou++;
    // Quote the most actionable live status line: prefer a needsYou session's,
    // else any running one's.
    const status = (s as any).thread_state_status;
    if (status && (band === "needsYou" || (band === "running" && !topStatus))) {
      topStatus = status;
      topSessionKey = (s as any).session_id ?? s._id;
    }
  }
  if (!sawAny) return null;
  return { working, needsYou, topStatus, topSessionKey };
}

export function fleetLine(f: FleetSummary): string {
  const parts: string[] = [];
  if (f.working) parts.push(`${f.working} working`);
  if (f.needsYou) parts.push(`${f.needsYou} need${f.needsYou === 1 ? "s" : ""} input`);
  return parts.join(" · ");
}
