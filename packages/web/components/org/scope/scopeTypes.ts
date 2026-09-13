// The scope page's contracts (docs/architecture/scopes-and-feed.md F2, F3 and
// org-roles-standing.md T2). `org.scopeFeed`, `org.scopeSummary` and
// `org.brief` return these shapes; the page paints from them. Types live here
// so the fixture, the hooks and the tabs agree on one definition.
import type { WorkState } from "@codecast/shared/contracts";
import type { OrgReportsTo, StateCounts } from "../orgTypes";

export type FeedKind = "session" | "task" | "plan" | "doc" | "artifact" | "decision" | "update" | "commit";
export const FEED_KINDS: FeedKind[] = ["session", "task", "plan", "doc", "artifact", "decision", "update", "commit"];

export type FeedActor = { name: string; image?: string; is_bot?: boolean };

export type FeedRow = {
  kind: FeedKind;
  id: string;
  short_id?: string;
  title: string;
  state?: string;
  actor?: FeedActor;
  updated_at: number;
  href: string;
  preview?: string;
  image_url?: string;
};

export type FeedPage = { rows: FeedRow[]; next_cursor?: string };

/** A sibling role that watches the same project or plan (F1 overlap warning). */
export type ScopeOverlap = {
  role_id: string;
  short_id: string;
  handle: string;
  name: string;
  project_ids: string[];
  plan_ids: string[];
};

export type ScopeSummary = {
  scope: { project_ids: string[]; plan_ids: string[] };
  projects: Array<{ id: string; title: string; short_id?: string; project_path?: string }>;
  plans: Array<{
    id: string; short_id: string; title: string; status: string; updated_at: number;
    progress: { total: number; done: number; in_progress: number; open: number };
  }>;
  tasks: { total: number; open: number; by_status: Record<string, number>; by_priority: Record<string, number> };
  sessions: StateCounts & { total: number };
  decisions: { open: number; answered: number };
  overlaps: ScopeOverlap[];
  generated_at: number;
};

export type TrustStage = "understand" | "decide" | "direct";
export const TRUST_STAGES: TrustStage[] = ["understand", "decide", "direct"];
export const TRUST_META: Record<TrustStage, { label: string; sentence: string; color: string }> = {
  understand: { label: "understand", sentence: "Reads and reports. Cannot answer decisions or start hands.", color: "var(--sol-blue)" },
  decide: { label: "decide", sentence: "Answers decisions inside its grants. Cannot start hands.", color: "var(--sol-violet)" },
  direct: { label: "direct", sentence: "Starts hands within its daily caps and answers decisions.", color: "var(--sol-green)" },
};

export type RoleCaps = { hands_per_day: number; wakes_per_day: number; tokens_per_day: number };
export type RoleCounters = { day: string; hands: number; wakes: number; tokens: number };
export const DEFAULT_CAPS: RoleCaps = { hands_per_day: 6, wakes_per_day: 40, tokens_per_day: 400_000 };

export type BriefHand = {
  _id: string;
  short_id: string;
  title: string;
  state: WorkState;
  state_line: string | null;
  state_status: string | null;
  state_at: number | null;
  updated_at: number;
  task: { short_id: string; title: string; status: string; execution_status?: string; review_verdict?: string; review_note?: string } | null;
};

export type BriefFacts = {
  scope: { projects: { id: string; title: string; short_id?: string }[]; plans: { id: string; short_id: string; title: string }[]; whole_workspace: boolean };
  tasks: ScopeSummary["tasks"];
  plans: ScopeSummary["plans"];
  hands: BriefHand[];
  changed: { kind: "task" | "plan"; short_id?: string; title: string; status: string; updated_at: number }[];
  decisions: { open: number; answered_today: number };
  usage: { day: string; wakes: number; hands: number; tokens: number; caps: RoleCaps; uncounted_sessions: number };
  generated_at: number;
};

export type RoleBrief = {
  role: {
    _id: string; short_id: string; name: string; handle: string; status: string;
    trust: TrustStage; reports_to: OrgReportsTo; review_backend: string | null;
    standing_short_id: string | null; standing_conversation_id: string | null;
    last_wake_at: number | null;
  };
  facts: BriefFacts;
  narrative: string;
  brief_doc_id: string | null;
  charter: string;
  charter_doc_id: string | null;
};

/** The first line of a brief's narrative: the state line the board shows. */
export function briefFirstLine(narrative: string | null | undefined): string {
  return (narrative ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

export const FEED_KIND_META: Record<FeedKind, { label: string; plural: string; color: string }> = {
  session: { label: "session", plural: "Sessions", color: "var(--sol-green)" },
  task: { label: "task", plural: "Tasks", color: "var(--sol-cyan)" },
  plan: { label: "plan", plural: "Plans", color: "var(--sol-magenta)" },
  doc: { label: "page", plural: "Pages", color: "var(--sol-blue)" },
  artifact: { label: "artifact", plural: "Artifacts", color: "var(--sol-orange)" },
  decision: { label: "decision", plural: "Decisions", color: "var(--sol-yellow)" },
  update: { label: "update", plural: "Updates", color: "var(--sol-violet)" },
  commit: { label: "commit", plural: "Commits", color: "var(--sol-text-muted)" },
};
