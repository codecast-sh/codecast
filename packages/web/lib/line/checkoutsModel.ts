// Every device's checkouts of one repository, as the pipeline page reads them
// (contracts/checkouts.ts, ct-98780): which machines hold work main does not
// have, whose it is, and what is stuck. A checkout holds work when it is ahead
// of main or has uncommitted edits; its level state says whether the daemon
// keeps it current, and when it cannot, on which file, since when, and who
// was told. Sessions are named by their titles in the viewer's own store,
// never by an id. Pure: no store, no React.
import { LEVEL_STUCK_FILE_MS, levelWriters, toldOf, type CheckoutLevel, type CheckoutRow, type CheckoutSession, type CheckoutSessionState, type CheckoutTold } from "@codecast/shared/contracts/checkouts";
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
  /** `stuckFor` is the one stuck age the row and the drawer both say; `heading` is the stuck reason as a heading
   *  ("Conflicts with main in 10 files"). */
  level: { tone: "ok" | "stuck" | "off"; words: string; reason: string | null; files: string[]; since: number | null; told: string | null; toldBrief: string | null; stuckFor: string | null; heading: string | null };
  /** A stuck level's readers: each session that last wrote some of the conflicting files, and the files nobody wrote,
   *  with whether each has been told this episode (by the daemon or from this page). Null when not stuck. */
  asks: { writers: CheckoutWriter[]; nobody: { files: string[]; told: boolean } } | null;
  /** A checkout (not a session's worktree) far behind main (FAR_BEHIND) with uncommitted work: it will not land cleanly
   *  unless someone acts. */
  farBehind: boolean;
  sessions: CheckoutSessionView[];
  /** Paths no session wrote; `reading` while the daemon is still reading transcripts to say whose they are. */
  unattributed: { paths: string[]; more: number; reading: boolean };
  device: string;
  machine: string;
  /** Finished sessions whose work waits here for nobody: what Ship sends. */
  finished: CheckoutSessionView[];
  /**
   * Where the page puts it: `needs` (stuck, or far behind with uncommitted work) leads the section; `ready` (finished
   * work nobody shipped) is one folded group after it; `stale` (a worktree the sweep leaves alone with no session live
   * in it) folds into one line per machine; the rest are its machine's rows.
   */
  place: "needs" | "ready" | "live" | "stale";
};

/** One session a stuck level's ask goes to: the conflicting files it last wrote. */
export type CheckoutWriter = { conversationId: string; title: string; files: string[]; told: boolean };

/** How far behind main a checkout holding uncommitted work has to be before it needs a person. */
export const FAR_BEHIND = 200;

export type MachineView = { device: string; machine: string; live: CheckoutView[]; stale: { checkouts: CheckoutView[]; files: number } };

export type CheckoutsPage = { needs: CheckoutView[]; ready: CheckoutView[]; machines: MachineView[] };

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
const conflicts = (reason: string) => /without a clean merge|conflict/i.test(reason);
const shortReason = (reason: string) => (conflicts(reason) ? "conflicts with main" : reason.replace(/^\d+ file\(s\) /, ""));

/** The level state in words, `now` for how long it has been stuck. */
export function levelWords(level: CheckoutLevel, now: number, titleOf: (conversationId: string) => string | null | undefined): CheckoutView["level"] {
  const calm = { since: null, told: null, toldBrief: null, stuckFor: null, heading: null, files: [] as string[] };
  if (level.state === "level") return { ...calm, tone: "ok", words: level.levelled_at ? `level with main, levelled ${spanWords(now - level.levelled_at)} ago` : "level with main", reason: null };
  if (level.state === "off") return { ...calm, tone: "off", words: `not kept level: ${level.reason}`, reason: level.reason };
  // The daemon tells the writer once the same files have refused for LEVEL_STUCK_FILE_MS; before that nobody is owed word.
  // Each writer hears of its own files; the files nobody wrote become one finding.
  const asked = toldOf(level);
  const sessions = asked.filter((t): t is Extract<CheckoutTold, { to: "session" }> => t.to === "session");
  const finding = asked.some((t) => t.to === "finding");
  const told = asked.length
    ? [
        ...(sessions.length === 1 ? [`told ${titleOf(sessions[0].conversation_id)?.trim() || "the session that wrote them"}`] : sessions.length ? [`told ${sessions.length} writers`] : []),
        ...(finding ? ["filed a finding"] : []),
      ].join(", ")
    : now - level.since >= LEVEL_STUCK_FILE_MS ? "nobody told yet" : `will tell its writers at ${Math.round(LEVEL_STUCK_FILE_MS / 60_000)}m`;
  const more = level.files.length > 1 ? ` +${level.files.length - 1}` : "";
  const toldBrief = sessions.length ? (sessions.length === 1 ? "told its writer" : `told ${sessions.length} writers`) : told;
  const stuckFor = spanWords(now - level.since);
  const n = level.files.length;
  const heading = conflicts(level.reason) ? `Conflicts with main in ${n} ${n === 1 ? "file" : "files"}` : `${shortReason(level.reason).replace(/^\w/, (c) => c.toUpperCase())}`;
  // A row says why and for how long; which files is the drawer's.
  const words = conflicts(level.reason) ? `conflicts in ${n} ${n === 1 ? "file" : "files"} · stuck ${stuckFor}` : `stuck ${stuckFor} on ${fileName(level.files[0] ?? "a file")}${more} · ${shortReason(level.reason)}`;
  return { tone: "stuck", words, reason: level.reason, files: level.files, since: level.since, told, toldBrief, stuckFor, heading };
}

/** A stuck level's readers and whether each has been told this episode: the daemon's asks and the page's alike. */
function asksOf(row: CheckoutRow, titleOf: (conversationId: string) => string | null | undefined, sessions: CheckoutSessionView[]): CheckoutView["asks"] {
  const told = toldOf(row.level as Extract<CheckoutLevel, { state: "stuck" }>);
  const { writers, nobody } = levelWriters(row);
  // The last writer first: the one whose work is freshest is the likeliest to still be at it.
  const lastAt = new Map(row.uncommitted.sessions.map((s) => [s.conversation_id ?? "", s.last_activity]));
  writers.sort((a, b) => (lastAt.get(b.conversation_id) ?? 0) - (lastAt.get(a.conversation_id) ?? 0));
  return {
    writers: writers.map((w) => ({
      conversationId: w.conversation_id,
      // Named as the work list names it, so a writer reads the same in both places.
      title: sessions.find((x) => x.conversationId === w.conversation_id)?.title ?? (titleOf(w.conversation_id)?.trim() || "the session that wrote them"),
      files: w.files,
      told: told.some((t) => t.to === "session" && t.conversation_id === w.conversation_id),
    })),
    nobody: { files: nobody, told: told.some((t) => t.to === "finding") },
  };
}

/**
 * A list of paths as a person scans it: grouped under their folders in the order given, at most `max` file rows, the
 * rest counted. A file keeps its whole name; only a folder may shorten.
 */
export function filesByFolder(paths: readonly string[], max = 8): { groups: Array<{ folder: string; names: string[] }>; more: number } {
  const groups: Array<{ folder: string; names: string[] }> = [];
  for (const p of paths.slice(0, max)) {
    const cut = p.lastIndexOf("/");
    const folder = cut < 0 ? "" : p.slice(0, cut + 1);
    const name = p.slice(cut + 1);
    const last = groups[groups.length - 1];
    if (last && last.folder === folder) last.names.push(name);
    else groups.push({ folder, names: [name] });
  }
  return { groups, more: Math.max(0, paths.length - max) };
}

/** One checkout as the page draws it. */
export function checkoutView(row: CheckoutRow, now: number, titleOf: (conversationId: string) => string | null | undefined): CheckoutView {
  const sessions = row.uncommitted.sessions.map((s) => sessionView(s, titleOf)).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastActivity - a.lastActivity);
  const finished = sessions.filter((s) => s.canShip);
  const holdsWork = (row.ahead ?? 0) > 0 || row.uncommitted.total > 0;
  // A worktree is a session's own place: far behind is its normal life, and its session lands it. A checkout is not.
  const worktree = row.level.state === "off" && row.level.reason === "a worktree";
  const farBehind = !worktree && (row.behind ?? 0) >= FAR_BEHIND && row.uncommitted.total > 0;
  const stuck = row.level.state === "stuck";
  return {
    id: row._id,
    folder: folderOf(row.path),
    path: row.path,
    branch: row.branch,
    ahead: row.ahead,
    behind: row.behind,
    fetchedAt: row.fetched_at,
    holdsWork,
    total: row.uncommitted.total,
    level: levelWords(row.level, now, titleOf),
    asks: stuck ? asksOf(row, titleOf, sessions) : null,
    farBehind,
    sessions,
    unattributed: { paths: row.uncommitted.unattributed, more: row.uncommitted.unattributed_more, reading: !!row.uncommitted.attributing },
    device: row.device_id,
    machine: row.device_label?.trim() || "a machine with no name",
    finished,
    place: stuck || farBehind ? "needs"
      : finished.length ? "ready"
      : worktree && !sessions.some((s) => s.state !== "finished") ? "stale"
      : "live",
  };
}

/**
 * A repository's checkouts as the page lays them out: what needs a person first (stuck, then far behind with
 * uncommitted work), then finished work ready to ship as one group, then each machine's live checkouts (those holding
 * work first) and its old worktrees folded to a count.
 */
export function checkoutsPage(rows: readonly CheckoutRow[], now: number, titleOf: (conversationId: string) => string | null | undefined): CheckoutsPage {
  const views = rows.map((r) => checkoutView(r, now, titleOf));
  // Stuck first, longest first; then far behind, furthest first.
  const needs = views.filter((c) => c.place === "needs").sort((a, b) => (a.level.since ?? Infinity) - (b.level.since ?? Infinity) || (b.behind ?? 0) - (a.behind ?? 0) || a.folder.localeCompare(b.folder));
  const ready = views.filter((c) => c.place === "ready").sort((a, b) => b.finished.length - a.finished.length || a.folder.localeCompare(b.folder));
  const by = new Map<string, MachineView>();
  for (const c of views) {
    if (c.place === "needs" || c.place === "ready") continue;
    const m = by.get(c.device) ?? { device: c.device, machine: c.machine, live: [], stale: { checkouts: [], files: 0 } };
    if (c.place === "stale") { m.stale.checkouts.push(c); m.stale.files += c.total; } else m.live.push(c);
    by.set(c.device, m);
  }
  const machines = [...by.values()];
  for (const m of machines) {
    m.live.sort((a, b) => Number(b.holdsWork) - Number(a.holdsWork) || a.folder.localeCompare(b.folder));
    m.stale.checkouts.sort((a, b) => b.total - a.total || a.folder.localeCompare(b.folder));
  }
  return { needs, ready, machines: machines.sort((a, b) => b.live.filter((c) => c.holdsWork).length - a.live.filter((c) => c.holdsWork).length || a.machine.localeCompare(b.machine)) };
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
