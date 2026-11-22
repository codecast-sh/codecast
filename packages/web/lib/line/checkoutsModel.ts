// Every device's checkouts of one repository, as the pipeline page reads them
// (contracts/checkouts.ts, ct-98780): which machines hold work main does not
// have, whose it is, and what is stuck. A checkout holds work when it is ahead
// of main or has uncommitted edits; its level state says whether the daemon
// keeps it current, and when it cannot, on which file, since when, and who
// was told. Sessions are named by their titles in the viewer's own store,
// never by an id. Pure: no store, no React.
import type { CheckoutLevel, CheckoutRow, CheckoutSession, CheckoutSessionState } from "@codecast/shared/contracts/checkouts";
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
  level: { tone: "ok" | "stuck" | "off"; words: string; files: string[]; since: number | null; told: string | null };
  sessions: CheckoutSessionView[];
  unattributed: { paths: string[]; more: number };
};

export type MachineView = { device: string; machine: string; checkouts: CheckoutView[] };

export type CheckoutsSummary = { checkouts: number; machines: number; holdingWork: number; stuck: number; behind: number };

/** A path under a home folder, said from home. */
export const folderOf = (path: string) => path.replace(/^\/(Users|home)\/[^/]+/, "~");

const STATE_RANK: Record<CheckoutSessionState, number> = { working: 0, idle: 1, finished: 2 };

function sessionView(s: CheckoutSession, titleOf: (conversationId: string) => string | null | undefined): CheckoutSessionView {
  const title = (s.conversation_id && titleOf(s.conversation_id)?.trim()) || `a ${s.client} session not synced here`;
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

/** The level state in words, `now` for how long it has been stuck. */
export function levelWords(level: CheckoutLevel, now: number, titleOf: (conversationId: string) => string | null | undefined): CheckoutView["level"] {
  if (level.state === "level") return { tone: "ok", words: level.levelled_at ? `level with main, levelled ${spanWords(now - level.levelled_at)} ago` : "level with main", files: [], since: null, told: null };
  if (level.state === "off") return { tone: "off", words: `not kept level: ${level.reason}`, files: [], since: null, told: null };
  const told = !level.filed ? "nobody told yet"
    : level.filed.to === "session" ? `told ${titleOf(level.filed.conversation_id)?.trim() || "the session that wrote it"}`
    : "filed as a finding";
  const file = level.files[0] ?? "a file";
  const more = level.files.length > 1 ? ` +${level.files.length - 1}` : "";
  return { tone: "stuck", words: `stuck ${spanWords(now - level.since)} on ${file}${more}: ${level.reason}`, files: level.files, since: level.since, told };
}

/** One checkout as the page draws it. */
export function checkoutView(row: CheckoutRow, now: number, titleOf: (conversationId: string) => string | null | undefined): CheckoutView {
  const sessions = row.uncommitted.sessions.map((s) => sessionView(s, titleOf)).sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastActivity - a.lastActivity);
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
    unattributed: { paths: row.uncommitted.unattributed, more: row.uncommitted.unattributed_more },
  };
}

/** A repository's checkouts by machine: stuck first, then those holding work, then the rest; machines in the same order. */
export function checkoutsByMachine(rows: readonly CheckoutRow[], now: number, titleOf: (conversationId: string) => string | null | undefined): MachineView[] {
  const rank = (c: CheckoutView) => (c.level.tone === "stuck" ? 0 : c.holdsWork ? 1 : 2);
  const by = new Map<string, MachineView>();
  for (const row of rows) {
    const m = by.get(row.device_id) ?? { device: row.device_id, machine: row.device_label?.trim() || "a machine with no name", checkouts: [] };
    m.checkouts.push(checkoutView(row, now, titleOf));
    by.set(row.device_id, m);
  }
  const machines = [...by.values()];
  for (const m of machines) m.checkouts.sort((a, b) => rank(a) - rank(b) || a.folder.localeCompare(b.folder));
  return machines.sort((a, b) => Math.min(...a.checkouts.map(rank)) - Math.min(...b.checkouts.map(rank)) || a.machine.localeCompare(b.machine));
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
