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

/** A word the shell reads as itself: quoted unless it is plain (a route like `routes/[id].tsx` stays literal). */
export const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

/**
 * The client id of a stuck level's ask to one writer: the device, the checkout, the episode (its files and start) and
 * the writer. The daemon's ask and the pipeline page's use the same one, so the server takes whichever comes first and
 * answers the other with that row: a writer hears of an episode once, whoever asks. A retry lands once too.
 */
export function levelAskClientId(a: { device_id: string; path: string; files: string[]; since: number; conversation: string }): string {
  return `level-told:${a.conversation}:${checkoutHash([a.device_id, a.path, [...a.files].sort(), a.since])}`;
}

/** What not to do in a shared checkout, said in every brief about one (the stuck level's ask, the raced level's). */
export const LEVEL_FORBID = "Never run git pull, merge, rebase, stash, checkout, restore, reset or commit in this shared checkout: other sessions' uncommitted work lives in it.";

/** What the daemon could write for one conflicting file: a three-way merge with markers, else why there is none. */
export type LevelMerge =
  | { kind: "merged"; file: string }
  | { kind: "upstream-deleted" }
  | { kind: "local-deleted"; file: string | null }
  | { kind: "binary" }
  | { kind: "none" };

/**
 * What only the machine holding the checkout can add to an ask: the full list of the reader's files (`list`), each
 * file's merge under `mergeDir` (`merges`), the upstream commits that touched them, and the upstream commit `to`
 * the merges were made against. Each part is optional; a part left out leaves its line out.
 */
export type LevelAskLocal = { list?: string; mergeDir?: string; merges?: Record<string, LevelMerge>; commits?: string[]; to?: string };

/** Why a file has no ordinary merge file, in a few words; null when it has one. */
function mergeNote(m: LevelMerge | undefined): string | null {
  switch (m?.kind) {
    case undefined: case "merged": return null;
    case "upstream-deleted": return "upstream deletes it: delete your copy, or move your edit to where upstream moved that code";
    case "local-deleted": return "deleted here and changed upstream: its merge file is upstream's version, to write back if the file should stay";
    case "binary": return "binary or a symlink, so no merge file: take upstream's version or redo your edit on it";
    case "none": return "no merge file could be written";
  }
}

/**
 * The words a stuck level's ask carries to one reader (the session that last wrote `mine`, or a finding for the files
 * nobody wrote): the checkout, how many of the conflicting files are this reader's and which, that the rest are
 * others' and told apart, and the one way out: bring upstream's change into each file by hand. The daemon adds what
 * it wrote on the machine (`local`): the list file, so only LEVEL_TOLD_PATHS_MAX files are named; a merge file per
 * file; the upstream commits. An ask sent from elsewhere (the pipeline page) has none of that, so it names every file
 * and, for each, the `git show` of upstream's version, quoted for the shell. One wording for both, so a writer reads
 * the same ask whoever sends it.
 * `sender` is the name the ask's card shows, since no session sends it.
 */
export function levelAskWords(
  r: { path: string; upstream: string | null; behind: number | null },
  level: { files: string[]; since: number },
  mine: string[],
  local: LevelAskLocal | null,
  opts: { host: string; whose: "session" | "nobody" },
): { title: string; body: string; sender: string } {
  const upstream = r.upstream ?? "origin/main";
  const name = r.path.replace(/\/+$/, "").split("/").pop() || r.path;
  const n = mine.length;
  const one = n === 1;
  const others = level.files.length - n;
  const since = new Date(level.since).toISOString().replace("T", " ").slice(0, 16);
  const what = opts.whose === "session" ? `${n} of your files` : `${n} file${one ? "" : "s"} no session wrote`;
  const title = `${name} on ${opts.host}: ${what} conflict${one ? "s" : ""} with ${upstream}`;
  const shown = (local?.list ? mine.slice(0, LEVEL_TOLD_PATHS_MAX) : mine).map((f) => {
    const note = mergeNote(local?.merges?.[f]);
    return `  ${f}${note ? ` (${note})` : ""}`;
  });
  const rev = local?.to ? local.to.slice(0, 9) : upstream;
  const show = `git -C ${shellWord(r.path)} show`;
  const wayOut = local?.mergeDir
    ? [`The way out, over these files only: bring upstream's change into each by hand. Its three-way merge, with conflict markers, is at ${local.mergeDir}/<file>: resolve the markers and write the result over the file, or redo your edit on upstream's version (\`${show} ${rev}:<file>\`).`]
    : [`The way out, over these files only: bring upstream's change into each by hand, redoing your edit on upstream's version:`, ...mine.map((f) => `  \`${show} ${shellWord(`${rev}:${f}`)}\``)];
  const body = [
    `The shared checkout ${r.path} on ${opts.host} has not followed ${upstream} since ${since} UTC${r.behind ? ` (${r.behind} commit${r.behind === 1 ? "" : "s"} behind)` : ""}, so every session in it misses upstream's work. ${one ? "This uncommitted file" : `These ${n} uncommitted files`} ${opts.whose === "session" ? `${one ? "was" : "were"} last written by this session` : `${one ? "has" : "have"} no session that wrote ${one ? "it" : "them"}`} and conflict${one ? "s" : ""} with upstream:`,
    ...shown,
    ...(local?.list && n > LEVEL_TOLD_PATHS_MAX ? [`  +${n - LEVEL_TOLD_PATHS_MAX} more`] : []),
    ...(local?.list ? [`The full list: ${local.list}`] : []),
    ...(others > 0 ? [`The other ${others} conflicting file${others === 1 ? "" : "s"} belong${others === 1 ? "s" : ""} to other sessions, which are told separately: leave ${others === 1 ? "it" : "them"} alone.`] : []),
    ...(local?.commits?.length ? ["", `Upstream changed ${one ? "it" : "them"} in:`, ...local.commits] : []),
    "",
    ...wayOut,
    `Edit only the files named here${local?.list ? " and in the list" : ""}. ${LEVEL_FORBID}`,
    `Once ${one ? "it carries" : "they carry"} upstream's change, the next level sweep (within a minute) moves the checkout by itself.`,
  ].join("\n");
  // Who the ask reads as from: no session sent it, so the card names the sweep and its machine.
  return { title, body, sender: `Checkout sweep on ${opts.host}` };
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
