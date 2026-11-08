// "Rewind to here" (cli/src/rewindTree.ts): the daemon command that rewinds a
// session's checkout to how it stood just before one of its turns, in place,
// with a way back. One shape for the args the web sends and the reply the
// daemon writes as the command's result.
//
// PURE isomorphic data: safe for the Convex runtime, the daemon and the browser.

/**
 * plan: what a rewind would do (no file moves).
 * diff: the unified diff of the plan, or of one path in it.
 * stage: back up the current versions, then rewind (refused on a stale review,
 *   and on conflicts unless `overwrite`).
 * put_back: restore the staged rewind's backup (refused on files edited after
 *   the rewind unless `overwrite`).
 * keep: keep the rewound files and drop the backup.
 */
export const REWIND_FILES_OPS = ["plan", "diff", "stage", "put_back", "keep"] as const;
export type RewindFilesOp = (typeof REWIND_FILES_OPS)[number];

export type RewindFilesArgs = {
  conversation_id: string;
  op: RewindFilesOp;
  /** The user message the tree rewinds to just before (ms). */
  message_ts?: number;
  /** stage: the plan the person reviewed. */
  fingerprint?: string;
  /** stage: rewind files someone else changed too; put_back: discard edits made after the rewind. */
  overwrite?: boolean;
  /** diff: one path. */
  path?: string;
  /** put_back, keep: the staged rewind the person is looking at; another one staged since is refused. */
  staged_id?: string;
  /** put_back with overwrite: the token of the edited set the person reviewed and chose to discard (from the refusal). */
  discard_token?: string;
};

export type RewindFileAction = "restore" | "delete" | "recreate";

export type RewindFilesStaged = {
  id: string;
  conversation_id: string;
  at: number;
  staged_at: number;
  /** Every file the rewind moved; `files` lists at most REWIND_FILES_LIST_CAP of them. */
  count: number;
  files: Array<{ path: string; action: RewindFileAction }>;
};

export type RewindFilesReply = {
  op: RewindFilesOp;
  /** Refused: the reason a person reads, with the paths it is about. */
  refused?: string;
  paths?: string[];
  /** The refusal's paths stand in the way and must be moved; no overwrite gets past them. */
  blocked?: boolean;
  /** A put back refused for edits: names that exact set, for a forced retry; `total` counts it when `paths` is cut. */
  token?: string;
  total?: number;
  /** plan and stage: the files and what happens to each. Capped at REWIND_FILES_LIST_CAP; counts are exact. */
  files?: Array<{ path: string; action: RewindFileAction; conflict: boolean }>;
  counts?: { restore: number; delete: number; recreate: number; conflict: number; total: number };
  fingerprint?: string;
  /** The session's snapshots after the message that the files were read from. */
  turns?: number;
  /** The rewind starts at the message itself; false for a session from before prompt snapshots, where it starts at the previous turn's end. */
  from_prompt?: boolean;
  /** HEAD moved since the message; commits are kept, only files move. */
  head_moved?: boolean;
  /** Files those turns' snapshots changed that the session's own edits do not name (a person, another session, a shell command): left alone. */
  left_alone?: number;
  left_alone_paths?: string[];
  /** An agent working in the checkout is mid-turn: staging waits for it. */
  busy?: boolean;
  /** The checkout's staged rewind, whichever session staged it. */
  staged?: RewindFilesStaged | null;
  /** The conversation whose staged rewind this reply sets or clears (the daemon reports it there). */
  staged_conversation_id?: string;
  /** With `staged: null`: the staged rewind this reply ended or found gone. Only a mark with this id clears. */
  cleared_id?: string;
  /** The checkout, for the review's subject line. */
  root?: string;
  diff?: string;
  truncated?: boolean;
  /** put_back: files restored. */
  restored?: number;
};

export const REWIND_FILES_LIST_CAP = 500;
/** treeSnapshots.listForConversation returns at most this many rows, newest first. */
export const REWIND_ROWS_CAP = 500;

/** A staged rewind as its conversation row carries it (conversations.rewind_staged): what the header chip reads. */
export type RewindStagedMark = { id: string; files: number; staged_at: number; at: number; /** The machine that holds the rewind. */ device_id?: string };
