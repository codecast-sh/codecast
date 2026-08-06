// What the current Files scope MEANS, in one place.
//
// THE MODEL. The project is the container; the team is a property of it. A
// scope answers two separate questions, and conflating them is what made this
// surface feel incoherent:
//
//   1. WHERE ARE THE BYTES? On this machine, on another machine, or both.
//      Files on disk are files on disk — nobody else can read them, ever.
//   2. WHO SEES WHAT YOU SYNC? A directory resolves to a team, so anything
//      that reaches codecast from here (a doc, a session) lands in that team.
//
// Docs are scoped by team and files are scoped by directory not because they
// are rival axes, but because they are the two ends of one pipe. A directory
// already knows its team (directory_team_mappings, longest prefix wins), so the
// user should never have to state it twice.
//
// Pure — no React, no store, no fetch — so the rules are unit-testable and the
// picker, the scope line and the header share ONE definition of each.

/** Where a scope's bytes actually live. */
export type VaultPresence = "this-machine" | "both" | "other-machine";

/**
 * Who can see what you sync out of a scope.
 *
 * `shared` separates the two team states that look identical but are not: a
 * directory that auto-shares (everything born team-visible) from one that a
 * team merely routes (born private; sharing is a per-item decision).
 */
export type VaultTeamScope =
  | { kind: "personal" }
  | { kind: "team"; teamId: string; teamName: string; shared: boolean };

export const PERSONAL_SCOPE: VaultTeamScope = { kind: "personal" };

/**
 * One session's verdict about the directory it ran in.
 *
 * This is deliberately NOT a re-implementation of resolveTeamForPath. Every
 * session was stamped by that function at creation, so `team_id`/`is_private`
 * ARE the mapping's answer for that path — already resolved, already in the
 * store. Reading the verdict beats re-deriving it: no new query, and no second
 * copy of the longest-prefix rule to drift out of sync with the server's.
 */
export interface ScopeEvidence {
  /** The directory the session ran in (git_root ?? project_path). */
  path: string;
  teamId?: string | null;
  isPrivate?: boolean;
  /** How many sessions this row stands for. Identical verdicts collapse into
   *  one weighted row so a repo with a thousand sessions costs the same to
   *  resolve as one with a single session — the picker asks per row. */
  weight?: number;
}

/** Trailing slashes make an exact-match comparison lie. */
function normalizeDir(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isAtOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

/**
 * Which team a directory files into, read off the sessions that ran there.
 *
 * CLOSEST EVIDENCE WINS. A session deeper inside the tree may have matched a
 * MORE specific mapping that does not govern the root itself, so only the
 * shallowest paths at or under the root are allowed to speak for it — the
 * mirror image of longest-prefix-wins on the mapping side.
 *
 * `shared` is a majority of that cohort rather than any single session: a
 * session carries no auto_share flag once synced, so one note the user shared
 * by hand must not relabel a personal folder as a team one.
 *
 * No evidence means personal, and that is the safe direction to be wrong in:
 * an unsynced directory really is personal until something leaves it.
 */
export function deriveTeamForRoot(
  root: string,
  evidence: readonly ScopeEvidence[],
  teamNameById: Readonly<Record<string, string>>,
): VaultTeamScope {
  const dir = normalizeDir(root);
  let cohort: ScopeEvidence[] = [];
  let closest = Infinity;

  for (const e of evidence) {
    if (!e.path) continue;
    const path = normalizeDir(e.path);
    if (!isAtOrUnder(path, dir)) continue;
    // Depth in directories, not characters: `/w/a/b` sits deeper under `/w`
    // than `/w/abcd` does, even though it is the shorter string.
    const depth = path === dir ? 0 : path.slice(dir.length + 1).split("/").length;
    if (depth < closest) {
      closest = depth;
      cohort = [e];
    } else if (depth === closest) {
      cohort.push(e);
    }
  }

  const teamId = cohort.find((e) => e.teamId)?.teamId;
  if (!teamId) return PERSONAL_SCOPE;

  let filed = 0;
  let visible = 0;
  for (const e of cohort) {
    if (e.teamId !== teamId) continue;
    const weight = e.weight ?? 1;
    filed += weight;
    if (!e.isPrivate) visible += weight;
  }
  return {
    kind: "team",
    teamId,
    // A team missing from the roster means a stale roster, not a missing team:
    // say so vaguely rather than dropping the sharing fact on the floor.
    teamName: teamNameById[teamId] ?? "your team",
    shared: visible * 2 >= filed,
  };
}

export function vaultPresence(opts: { remote: boolean; mirror?: boolean }): VaultPresence {
  if (opts.remote) return "other-machine";
  return opts.mirror ? "both" : "this-machine";
}

const PRESENCE_WORDS: Record<VaultPresence, string> = {
  "this-machine": "on this machine",
  both: "on this machine, synced to codecast",
  "other-machine": "on another machine, read only",
};

/** The short badge next to a row, where a full sentence will not fit. */
export const PRESENCE_LABELS: Record<VaultPresence, string> = {
  "this-machine": "This machine",
  both: "Synced",
  "other-machine": "Elsewhere",
};

/**
 * Who sees it, in words — kept short enough to survive a 180px rail, because
 * this clause is the one thing on the line that cannot be inferred from an
 * icon. The full context is the sentence below.
 */
export function teamScopeWords(team: VaultTeamScope): string {
  if (team.kind === "personal") return "personal";
  return team.shared ? `shared with ${team.teamName}` : `private, filed under ${team.teamName}`;
}

export function teamScopeLabel(team: VaultTeamScope): string {
  return team.kind === "personal" ? "Personal" : team.teamName;
}

/**
 * The whole scope as a sentence. This is the line that stops people guessing,
 * so it names the directory rather than the display name: two checkouts of one
 * repo share a name and nothing else.
 */
export function describeVaultScope(opts: {
  root?: string;
  presence: VaultPresence;
  team: VaultTeamScope;
}): string {
  const where = PRESENCE_WORDS[opts.presence];
  const who = teamScopeWords(opts.team);
  return opts.root ? `${opts.root} — ${where}, ${who}` : `${where}, ${who}`;
}

/**
 * The codecast doc mirroring a file on disk, if there is one.
 *
 * `docs.source_file` holds the absolute path of the file a doc was synced from,
 * while the Files surface addresses everything vault-relative — so the join is
 * the vault root plus the relative path. This is the one honest answer to
 * "where did I write that?": both places, and here is the other one.
 */
export function findDocForFile<T extends { _id: string; source_file?: string | null }>(
  root: string | undefined,
  relPath: string | null | undefined,
  docs: Readonly<Record<string, T>>,
): T | null {
  if (!root || !relPath) return null;
  const abs = `${normalizeDir(root)}/${relPath}`;
  for (const id in docs) {
    if (docs[id]?.source_file === abs) return docs[id];
  }
  return null;
}
