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

/** Where a stuck level's ask for help went: the session that last wrote one of its files, else a finding on the repository's project. */
export type CheckoutFiled = { at: number } & ({ to: "session"; conversation_id: string } | { to: "finding" });

/** The daemon's level sweep on this checkout (ship-checkout.md, land/levelSweep.ts). */
export type CheckoutLevel =
  /** At origin's default branch: levelled then (null: never moved by the sweep since the daemon started). */
  | { state: "level"; levelled_at: number | null }
  /** Refused, the same files each pass since `since`. `filed`: the one ask for help this episode made, and to whom; null until it goes. */
  | { state: "stuck"; files: string[]; reason: string; since: number; filed: CheckoutFiled | null }
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
  /** Uncommitted paths, by the session that wrote each last; the rest unattributed (a person, a formatter). */
  uncommitted: { total: number; sessions: CheckoutSession[]; unattributed: string[]; unattributed_more: number };
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
