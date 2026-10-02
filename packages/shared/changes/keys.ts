// Stable keys for stories and the hash that decides when prose is stale
// (docs/proposals/changes-page.md 7.2). Convex's default runtime has no node
// crypto, so both ride the FNV-1a the inbox digest already uses, run as two
// chained lanes for a 64-bit value.
import { fnv1a32Update, FNV1A32_OFFSET } from "../contracts/inboxProjection";

/** 16 hex chars over the parts, joined with a separator no id contains. */
export function hash64(parts: readonly string[]): string {
  const s = parts.join("\u001f");
  const a = fnv1a32Update(FNV1A32_OFFSET, s);
  // The second lane continues from the first, so two strings that collide in
  // lane A still diverge here unless they also collide from a different start.
  const b = fnv1a32Update(a ^ 0x9e3779b9, s);
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/**
 * The anchor of a story: its session when one anchors it, else the cluster's
 * `branch|area|scope|first_sha`. Late commits join at the end, so the anchor
 * and the key stay put while a day is live.
 */
export function clusterAnchor(branch: string, area: string, scope: string | null, firstSha: string): string {
  return `${branch}|${area}|${scope ?? ""}|${firstSha}`;
}

export function storyKey(teamId: string, repository: string, date: string, anchor: string): string {
  return hash64(["story", teamId, repository, date, anchor]);
}

/** Everything the story prompt reads that can change under a story. Nothing else enters the hash. */
export type StoryInputs = {
  prompt_version: string;
  shas: readonly string[];
  insights: readonly { id: string; generated_at: number }[];
  /** Each visible conversation's effective visibility mode. */
  visibility: readonly { conversation_id: string; mode: string }[];
  /** Each session owner's membership level for that session. */
  membership: readonly { conversation_id: string; level: string }[];
  prs: readonly { id: string; updated_at: number }[];
  risks: readonly string[];
};

/** Order-free: the same inputs in any order hash the same. */
export function inputsHash(i: StoryInputs): string {
  const sorted = (xs: readonly string[]) => [...xs].sort();
  return hash64([
    "inputs",
    i.prompt_version,
    sorted(i.shas).join(","),
    sorted(i.insights.map((x) => `${x.id}@${x.generated_at}`)).join(","),
    sorted(i.visibility.map((x) => `${x.conversation_id}=${x.mode}`)).join(","),
    sorted(i.membership.map((x) => `${x.conversation_id}=${x.level}`)).join(","),
    sorted(i.prs.map((x) => `${x.id}@${x.updated_at}`)).join(","),
    sorted(i.risks).join(","),
  ]);
}
