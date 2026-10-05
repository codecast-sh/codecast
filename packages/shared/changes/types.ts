// The plain records layer 0 reads and writes (docs/proposals/changes-page.md
// 7.1). Ids are strings so the same functions run over Convex rows, test
// fixtures and anything else that can spell a commit.
import type { AreaTouch, ChangeKind } from "./classify";

/** One commit as buildDay projects it (spec 7.1 step 1). */
export type ChangeCommit = {
  sha: string;
  subject: string;
  /** Message body, trailers stripped, capped at 600 chars by the reader. */
  body?: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  /** When the row was written; breaks ties between rebase twins. */
  created_at?: number;
  /** The ref the push landed on. Absent for transcript-path commits, read as the default branch. */
  branch?: string | null;
  conversation_id?: string | null;
  task_ids?: string[];
  pr_id?: string | null;
  insertions: number;
  deletions: number;
  areas: Record<string, AreaTouch>;
  /** The same touches one folder deeper, keyed `area/sub` (classify.narrowAreas). */
  subareas?: Record<string, AreaTouch>;
  top_paths?: string[];
  schema_paths?: string[];
};

/** A conversation that passed `teamVisibleInputs()`. Only these group commits or join stories. */
export type VisibleConversation = {
  conversation_id: string;
  /** Tasks the conversation worked; two conversations sharing one form one story. */
  task_ids?: string[];
  /** Its insight's outcome; `blocked` raises the story's blocked risk. */
  outcome_type?: "shipped" | "progress" | "blocked" | "unknown";
};

/** A pull request layer 0 can join to a story by session or by commit. */
export type ChangePr = {
  id: string;
  /** Its number, which a squash or merge commit names on its subject instead of carrying the pull request's shas. */
  number?: number;
  conversation_ids?: string[];
  shas?: string[];
};

/** A moment a surface went out: a release commit, a tag, or a deploy marker. */
export type ShipEvent = {
  surface: string;
  version?: string;
  sha: string;
  at: number;
  /** `release` for bumps and tags, `deploy` for `cast ship mark`. */
  kind: "release" | "deploy";
};

export type RiskCode = "skew" | "schema" | "revert" | "bulk" | "blocked";

export type Risk = { code: RiskCode; evidence: string[] };

/** A release burst: release commits within 10 minutes, restamps folded in. */
export type ReleaseBurst = {
  shas: string[];
  releases: ShipEvent[];
  first_at: number;
  last_at: number;
};

/** One story's facts, before any prose (spec 7.1 output). */
export type LayerZeroStory = {
  story_key: string;
  anchor: string;
  area: string;
  scope: string | null;
  branch: string;
  on_default_branch: boolean;
  commit_shas: string[];
  /** Shas whose whole commit is in the story; the rest joined as area slices of a batch commit. */
  whole_shas: string[];
  conversation_ids: string[];
  /** Commits here whose conversation failed the gate, counted by conversation. Never named. */
  private_conversation_count: number;
  task_ids: string[];
  pr_ids: string[];
  author_names: string[];
  insertions: number;
  deletions: number;
  files_changed: number;
  area_counts: Record<string, number>;
  first_at: number;
  last_at: number;
  release: ShipEvent | null;
  risks: Risk[];
  kind: ChangeKind;
  importance: number;
  headline: string;
  dek: string;
};
