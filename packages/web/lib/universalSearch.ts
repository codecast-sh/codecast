// Search across the objects the local store already holds, the instant tier
// of every search surface (web's Cmd-K palette, the phone's search). Server
// search lands on top of it (hooks/useRemoteSearch).

import { collapseSameTitle, score } from "./mentionRanking";
import { inActiveWorkspace } from "./workspaceScope";

// One matcher for tasks/docs/plans over the globally-synced mention index.
// Reuses score() (exact > prefix > substring) with a short_id fallback, and
// mirrors the Tasks/Docs pages' team scoping: in a team view keep this team's
// items plus teamless orphans; in the personal view keep only teamless items.
export type MentionRecord = {
  _id: string;
  title: string;
  short_id?: string;
  goal?: string;
  doc_type?: string;
  source_file?: string | null;
  status?: string;
  updated_at?: number;
  team_id?: string | null;
};
export function matchEntities(
  records: Record<string, MentionRecord>,
  query: string,
  teamId: string | undefined,
  cap: number,
  exclude?: (r: MentionRecord) => boolean,
  // With no query, list the most recent records instead of nothing (pick mode
  // browses; the root palette stays session-focused when empty).
  browseWhenEmpty = false,
): MentionRecord[] {
  const q = query.trim().toLowerCase();
  if (!q && !browseWhenEmpty) return [];
  const ranked: Array<{ rec: MentionRecord; rank: number }> = [];
  for (const rec of Object.values(records)) {
    if (exclude?.(rec)) continue;
    if (!inActiveWorkspace(rec, teamId)) continue;
    if (!q) { ranked.push({ rec, rank: 0 }); continue; }
    const titleRank = score(rec.title || "", q);
    const goalRank = rec.goal ? score(rec.goal, q) : Infinity;
    // File-synced docs are titled from their content heading, not their filename;
    // score the source file too so a doc is findable by name/path. Score the
    // basename (strong prefix match) and the full path (matches "dir/file.md").
    let fileRank = Infinity;
    if (rec.source_file) {
      const path = rec.source_file.toLowerCase();
      const base = path.split("/").pop() || path;
      fileRank = Math.min(score(base, q), score(path, q));
    }
    let rank = Math.min(titleRank, goalRank, fileRank);
    if (rank === Infinity) {
      if (!rec.short_id?.toLowerCase().includes(q)) continue;
      rank = 50; // short_id-only hit ranks below any title/goal hit
    }
    ranked.push({ rec, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || (b.rec.updated_at || 0) - (a.rec.updated_at || 0));
  // Collapse same-title records to one row. Workflow-generated tasks/plans often
  // share an identical title across many distinct ids/statuses (e.g. a "Verify
  // task list covers entire plan" task minted every run), which floods the
  // palette with apparent dupes. Sorted best-first, so the first occurrence per
  // title is the highest-ranked, most-recent representative.
  return collapseSameTitle(ranked.map((r) => r.rec), (rec) => rec.title, cap);
}

/** Tasks, plans and docs a query names, each ranked and capped, as every search surface groups them: dropped tasks, abandoned plans and plan-type docs left out. */
export function matchMentionGroups(
  index: { tasks: Record<string, any>; docs: Record<string, any>; plans: Record<string, any> },
  query: string,
  teamId: string | undefined,
  cap: number,
  browse: { task?: boolean; doc?: boolean; plan?: boolean } = {},
): { tasks: MentionRecord[]; docs: MentionRecord[]; plans: MentionRecord[] } {
  return {
    tasks: matchEntities(index.tasks, query, teamId, cap, (t) => t.status === "dropped", browse.task),
    docs: matchEntities(index.docs, query, teamId, cap, (d) => d.doc_type === "plan", browse.doc),
    plans: matchEntities(index.plans, query, teamId, cap, (p) => p.status === "abandoned", browse.plan),
  };
}
