// Every device's checkouts of one repository, as the pipeline page reads them
// (contracts/checkouts.ts, ct-98780): which machines hold work main does not
// have, whose it is, and what is stuck. A checkout holds work when it is ahead
// of main or has uncommitted edits; its level state says whether the daemon
// keeps it current, and when it cannot, on which file, since when, and who
// was told. Sessions are named by their titles in the viewer's own store,
// never by an id. Pure: no store, no React.
import { LEVEL_STUCK_FILE_MS, type CheckoutLevel, type CheckoutRow, type CheckoutSession, type CheckoutSessionState } from "@codecast/shared/contracts/checkouts";
import { spanWords } from "./pipelineModel";

export type CheckoutSessionView = {
  key: string;
  conversationId: string | null;
  title: string;
  state: CheckoutSessionState;
  lastActivity: number;
  paths: string[];
  more: number;
  /** Finished work with a conversation to ask: Ship sends that session the flow's run message. */
  canShip: boolean;
};

export type CheckoutView = {
  id: string;
  /** The folder as a person reads it: `~/src/union-mobile`. */
  folder: string;
  path: string;
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  fetchedAt: number | null;
  /** Commits main lacks, or uncommitted edits. */
  holdsWork: boolean;
  total: number;
  /** `words` fits a glance (`stuck 18m on bun.lock +2 · conflicts with main`); `reason` is git's whole sentence, for the drawer. */
  /** `told` names whom (the drawer); `toldBrief` fits a row: `told its writer`, `nobody told yet`. */
  level: { tone: "ok" | "stuck" | "off"; words: string; reason: string | null; files: string[]; since: number | null; told: string | null; toldBrief: string | null };
  sessions: CheckoutSessionView[];
  /** Paths no session wrote; `reading` while the daemon is still reading transcripts to say whose they are. */
  unattributed: { paths: string[]; more: number; reading: boolean };
  device: string;
  machine: string;
  /** Finished sessions whose work waits here for nobody: what Ship sends. */
  finished: CheckoutSessionView[];
  /**
   * Where the page puts it: `needs` (stuck, or finished work to ship) leads the section; `stale` (a worktree the
   * sweep leaves alone with no session live in it) folds into one line per machine; the rest are its machine's rows.
   */
  place: "needs" | "live" | "stale";
};

export type MachineView = { device: string; machine: string; live: CheckoutView[]; stale: { checkouts: CheckoutView[]; files: number } };

export type CheckoutsPage = { needs: CheckoutView[]; machines: MachineView[] };

export type CheckoutsSummary = { checkouts: number; machines: number; holdingWork: number; stuck: number; behind: number };

/** A path under a home folder, said from home. */
export const folderOf = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

const STATE_RANK: Record<CheckoutSessionState, number> = { working: 0, idle: 1, finished: 2 };

function sessionView(s: CheckoutSession, titleOf: (conversationId: string) => string | null | undefined): CheckoutSessionView {
  // A synced session this window has not loaded still opens; one the daemon only reads locally does not.
  const title = (s.conversation_id && titleOf(s.conversation_id)?.trim()) || (s.conversation_id ? `a ${s.client} session` : `a ${s.client} session not synced here`);
  return {
    key: s.conversation_id ?? s.session_id,
    conversationId: s.conversation_id,
    title,
    state: s.state,
    lastActivity: s.last_activity,
    paths: s.paths,
    more: s.more,
    canShip: s.state === "finished" && !!s.conversation_id,
  };
}

const fileName = (path: string) => path.split("/").pop() || path;

/** Git's refusal in a few words; the whole sentence stays in `reason`. */
const shortReason = (reason: string) => (/without a clean merge|conflict/i.test(reason) ? "conflicts with main" : reason.replace(/^\d+ file\(s\) /, ""));

/** The level state in words, `now` for how long it has been stuck. */
export function levelWords(level: CheckoutLevel, now: number, titleOf: (conversationId: string) => string | null | undefined): CheckoutView["level"] {
  if (level.state === "level") return { tone: "ok", words: level.levelled_at ? `level with main, levelled ${spanWords(now - level.levelled_at)} ago` : "level with main", reason: null, files: [], since: null, told: null, toldBrief: null };
  if (level.state === "off") return { tone: "off", words: `not kept level: ${level.reason}`, reason: level.reason, files: [], since: null, told: null, toldBrief: null };
  // The daemon tells the writer once the same files have refused for LEVEL_STUCK_FILE_MS; before that nobody is owed word.
  const told = level.filed
    ? level.filed.to === "session" ? `told ${titleOf(level.filed.conversation_id)?.trim() || "the session that wrote it"}` : "filed as a finding"
    : now - level.since >= LEVEL_STUCK_FILE_MS ? "nobody told yet" : `will tell its writer at ${Math.round(LEVEL_STUCK_FILE_MS / 60_000)}m`;
  const more = level.files.length > 1 ? ` +${level.files.length - 1}` : "";
  const toldBrief = level.filed?.to === "session" ? "told its writer" : told;
  return { tone: "stuck", words: `stuck ${spanWords(now - level.since)} on ${fileName(level.files[0] ?? "a file")}${more} · ${shortReason(level.reason)}`, reason: level.reason, files: level.files, since: level.since, told, toldBrief };
}

/** One checkout as the page draws it. */
export function checkoutView(row: CheckoutRow, now: number, titleOf: (conversationId: string) => string | null | undefined): CheckoutView {
  const sessions = row.uncommitted.sessions.map((s) => sessionView(s, titleOf)).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastActivity - a.lastActivity);
  const finished = sessions.filter((s) => s.canShip);
  return {
    id: row._id,
    folder: folderOf(row.path),
    path: row.path,
    branch: row.branch,
    ahead: row.ahead,
    behind: row.behind,
    fetchedAt: row.fetched_at,
    holdsWork: (row.ahead ?? 0) > 0 || row.uncommitted.total > 0,
    total: row.uncommitted.total,
    level: levelWords(row.level, now, titleOf),
    sessions,
    unattributed: { paths: row.uncommitted.unattributed, more: row.uncommitted.unattributed_more, reading: !!row.uncommitted.attributing },
    device: row.device_id,
    machine: row.device_label?.trim() || "a machine with no name",
    finished,
    place: row.level.state === "stuck" || finished.length ? "needs"
      : row.level.state === "off" && row.level.reason === "a worktree" && !sessions.some((s) => s.state !== "finished") ? "stale"
      : "live",
  };
}

/**
 * A repository's checkouts as the page lays them out: what needs a person first (stuck before work to ship, the longest
 * stuck first), then each machine's live checkouts (those holding work first) and its old worktrees folded to a count.
 */
export function checkoutsPage(rows: readonly CheckoutRow[], now: number, titleOf: (conversationId: string) => string | null | undefined): CheckoutsPage {
  const views = rows.map((r) => checkoutView(r, now, titleOf));
  const needs = views.filter((c) => c.place === "needs").sort((a, b) => (a.level.since ?? Infinity) - (b.level.since ?? Infinity) || b.finished.length - a.finished.length || a.folder.localeCompare(b.folder));
  const by = new Map<string, MachineView>();
  for (const c of views) {
    if (c.place === "needs") continue;
    const m = by.get(c.device) ?? { device: c.device, machine: c.machine, live: [], stale: { checkouts: [], files: 0 } };
    if (c.place === "stale") { m.stale.checkouts.push(c); m.stale.files += c.total; } else m.live.push(c);
    by.set(c.device, m);
  }
  const machines = [...by.values()];
  for (const m of machines) {
    m.live.sort((a, b) => Number(b.holdsWork) - Number(a.holdsWork) || a.folder.localeCompare(b.folder));
    m.stale.checkouts.sort((a, b) => b.total - a.total || a.folder.localeCompare(b.folder));
  }
  return { needs, machines: machines.sort((a, b) => b.live.filter((c) => c.holdsWork).length - a.live.filter((c) => c.holdsWork).length || a.machine.localeCompare(b.machine)) };
}

/** The figures the page leads with. */
export function checkoutsSummary(rows: readonly CheckoutRow[]): CheckoutsSummary {
  return {
    checkouts: rows.length,
    machines: new Set(rows.map((r) => r.device_id)).size,
    holdingWork: rows.filter((r) => (r.ahead ?? 0) > 0 || r.uncommitted.total > 0).length,
    stuck: rows.filter((r) => r.level.state === "stuck").length,
    behind: rows.filter((r) => (r.behind ?? 0) > 0).length,
  };
}
