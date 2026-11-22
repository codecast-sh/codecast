// Every device's checkouts of a repository (pipeline.md PL6, ct-98780): where
// each one stands against origin's default branch, the uncommitted work in it
// grouped by the session that wrote it, and whether the daemon's level sweep
// keeps it level or is stuck. The daemon reports a checkout when this changes
// (its hash), the server keeps one row per device and path, and the pipeline
// page draws them. One shape for all three. Derived, never edited.

/** At most this many paths a session's group carries, sessions a checkout carries, and unattributed paths. */
export const CHECKOUT_PATHS_MAX = 25;
export const CHECKOUT_SESSIONS_MAX = 20;

/**
 * - `working`: mid-turn now (its hook status says so).
 * - `idle`: its transcript moved within CHECKOUT_IDLE_MS, between turns.
 * - `finished`: quiet longer than that: its edits wait for nobody (Ship offers to land them).
 */
export const CHECKOUT_SESSION_STATES = ["working", "idle", "finished"] as const;
export type CheckoutSessionState = (typeof CHECKOUT_SESSION_STATES)[number];
export const CHECKOUT_IDLE_MS = 30 * 60_000;

/** One session's uncommitted edits in the checkout: the files it wrote last. */
export type CheckoutSession = {
  /** The codecast conversation, when the transcript is synced; null for one the daemon only reads locally. */
  conversation_id: string | null;
  /** The agent's own session id (claude, codex). */
  session_id: string;
  client: string;
  state: CheckoutSessionState;
  /** Its newest transcript write, ms. */
  last_activity: number;
  /** Repo-relative paths, newest write first, at most CHECKOUT_PATHS_MAX. */
  paths: string[];
  /** How many paths the list leaves out. */
  more: number;
};

/**
 * One ask a stuck level made: to a session about the conflicting files it last wrote, or, for the files no session
 * wrote, a finding on the repository's project. `files`: how many of the conflicting files the ask was about.
 */
export type CheckoutTold = { at: number; files: number } & ({ to: "session"; conversation_id: string } | { to: "finding" });

/** Who a stuck level has told, from a report of either shape: an earlier daemon reported its single ask as `filed`. */
export function toldOf(level: { told?: CheckoutTold[]; filed?: (Omit<CheckoutTold, "files"> & { files?: number }) | null }): CheckoutTold[] {
  return level.told ?? (level.filed ? [{ ...level.filed, files: level.filed.files ?? 0 } as CheckoutTold] : []);
}

/** At most this many paths a stuck level's ask names inline; the rest are in the list file it points to. */
export const LEVEL_TOLD_PATHS_MAX = 8;

/** The daemon's level sweep on this checkout (ship-checkout.md, land/levelSweep.ts). */
export type CheckoutLevel =
  /** At origin's default branch: levelled then (null: never moved by the sweep since the daemon started). */
  | { state: "level"; levelled_at: number | null }
  /** Refused, the same files each pass since `since`. `told`: who has been asked for help this episode, each about its own files (empty until the grace passes). */
  | { state: "stuck"; files: string[]; reason: string; since: number; told: CheckoutTold[] }
  /** Not levelled by the sweep, and why: off for this repo, a worktree, off the default branch, holds commits main lacks, a ship running. */
  | { state: "off"; reason: string };

export type CheckoutReport = {
  /** `owner/name`, lowercased. */
  repository: string;
  device_id: string;
  /** The checkout's absolute path on that device. */
  path: string;
  /** The branch checked out; null when HEAD is detached. */
  branch: string | null;
  /** The default branch it is compared with (`origin/main`). */
  upstream: string | null;
  head_sha: string | null;
  /** Commits HEAD has that upstream lacks, and the reverse, as of `fetched_at`. */
  ahead: number | null;
  behind: number | null;
  /** When upstream was last fetched here (FETCH_HEAD); null when never. */
  fetched_at: number | null;
  /**
   * Uncommitted paths, by the session that wrote each last; the rest unattributed (a person, a formatter).
   * `attributing`: the daemon is still reading this checkout's transcripts (a little each pass), so every path is
   * listed unattributed for now; the sessions arrive with a later report.
   */
  uncommitted: { total: number; sessions: CheckoutSession[]; unattributed: string[]; unattributed_more: number; attributing?: true };
  level: CheckoutLevel;
};

/** A checkout as the server keeps and returns it. */
export type CheckoutRow = CheckoutReport & {
  _id: string;
  workspace: string;
  reported_at: number;
  /** The device's own name as its owner set it (devices.label: "Ashot Main Mac"); null when the server has none. */
  device_label: string | null;
};

/** The hash a daemon reports on change by: everything the page draws, so an unchanged checkout sends nothing. */
export function checkoutHash(r: unknown): string {
  const text = JSON.stringify(r);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/** How long a level refuses on the same files before the session that wrote them (else the device's owner) hears of it. */
export const LEVEL_STUCK_FILE_MS = 30 * 60_000;

const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/**
 * The words a stuck level's ask carries to one reader (the session that last wrote `mine`, or a finding for the files
 * nobody wrote): the checkout, how many of the conflicting files are this reader's and which, that the rest are
 * others' and told apart, and the two ways out over exactly its files. The daemon names a list file it wrote on the
 * machine (`files`); an ask sent from elsewhere (the pipeline page) has none, so it names every file and the ways out
 * spell them. One wording for both, so a writer reads the same ask whoever sends it.
 */
export function levelAskWords(
  r: { path: string; upstream: string | null; behind: number | null },
  level: { files: string[]; since: number },
  mine: string[],
  files: { list: string; patch: string } | null,
  opts: { host: string; whose: "session" | "nobody" },
): { title: string; body: string } {
  const upstream = r.upstream ?? "origin/main";
  const name = r.path.replace(/\/+$/, "").split("/").pop() || r.path;
  const n = mine.length;
  const others = level.files.length - n;
  const since = new Date(level.since).toISOString().replace("T", " ").slice(0, 16);
  const what = opts.whose === "session" ? `${n} of your files` : `${n} file${n === 1 ? "" : "s"} no session wrote`;
  const title = `${name} on ${opts.host}: ${what} conflict${n === 1 ? "s" : ""} with ${upstream}`;
  const shown = (files ? mine.slice(0, LEVEL_TOLD_PATHS_MAX) : mine).map((f) => `  ${f}`);
  const literal = `git --literal-pathspecs -C ${shellWord(r.path)}`;
  const patch = files?.patch ?? `/tmp/${name}-level.patch`;
  const named = mine.map(shellWord).join(" ");
  const aside = files
    ? `\`tr '\\n' '\\0' < ${shellWord(files.list)} | xargs -0 ${literal} diff -- > ${shellWord(patch)} && ${literal} checkout --pathspec-from-file=${shellWord(files.list)}\``
    : `\`${literal} diff -- ${named} > ${shellWord(patch)} && ${literal} checkout -- ${named}\``;
  const body = [
    `The daemon on ${opts.host} has not levelled ${r.path} to ${upstream} since ${since} UTC${r.behind ? ` (${r.behind} commits behind)` : ""}. ${opts.whose === "session" ? `These ${n} uncommitted file${n === 1 ? " was" : "s were"} last written by this session` : `These ${n} uncommitted file${n === 1 ? " has" : "s have"} no session that wrote ${n === 1 ? "it" : "them"}`} and conflict with ${upstream}:`,
    ...shown,
    ...(files && n > LEVEL_TOLD_PATHS_MAX ? [`  +${n - LEVEL_TOLD_PATHS_MAX} more`] : []),
    ...(files ? [`The full list: ${files.list}`] : []),
    ...(others > 0 ? [`The other ${others} conflicting file${others === 1 ? "" : "s"} belong${others === 1 ? "s" : ""} to other sessions, which are told separately: leave ${others === 1 ? "it" : "them"} alone.`] : []),
    "",
    `Either way out, over these files only, lets the next sweep level the checkout:`,
    `1. Rebase each onto main's version: \`${literal} show ${upstream}:<file>\` is main's; make your change again on top of it.`,
    `2. Set them aside as a patch, then restore main's: ${aside}; later \`${literal} apply --3way ${shellWord(patch)}\`.`,
  ].join("\n");
  return { title, body };
}

/**
 * A stuck level's conflicting files by who should hear of them, as a checkout's report shows it: each file goes to the
 * synced session that wrote it most recently (its newest write first), the rest to nobody (a finding). The daemon reads
 * whole transcripts for this; a report carries each session's newest CHECKOUT_PATHS_MAX paths, so a file past that
 * reads as nobody's here.
 */
export function levelWriters(r: { uncommitted: { sessions: CheckoutSession[] }; level: CheckoutLevel }): { writers: Array<{ conversation_id: string; files: string[] }>; nobody: string[] } {
  if (r.level.state !== "stuck") return { writers: [], nobody: [] };
  const sessions = r.uncommitted.sessions.filter((s) => !!s.conversation_id).sort((a, b) => b.last_activity - a.last_activity);
  const by = new Map<string, string[]>();
  const nobody: string[] = [];
  for (const f of r.level.files) {
    const s = sessions.find((x) => x.paths.includes(f));
    if (!s) { nobody.push(f); continue; }
    by.set(s.conversation_id!, [...(by.get(s.conversation_id!) ?? []), f]);
  }
  return { writers: [...by].map(([conversation_id, files]) => ({ conversation_id, files })), nobody };
}

/** An ask made from the pipeline page on a stuck checkout (checkouts.ask), kept on the row apart from the daemon's report:
 *  it counts as told while the episode it was made in (`since`) lasts. */
export type CheckoutPageAsk = CheckoutTold & { since: number };

/** The level as the page reads it: the daemon's asks and the page's for this episode, one per reader. */
export function withPageAsks(level: CheckoutLevel, asks: readonly CheckoutPageAsk[] | undefined): CheckoutLevel {
  if (level.state !== "stuck" || !asks?.length) return level;
  const told = [...toldOf(level)];
  const key = (t: CheckoutTold) => (t.to === "session" ? t.conversation_id : "finding");
  for (const a of asks) {
    if (a.since !== level.since || told.some((t) => key(t) === key(a))) continue;
    const { since: _s, ...t } = a;
    told.push(t as CheckoutTold);
  }
  return { ...level, told };
}
