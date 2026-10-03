// Stable keys for stories and the hash that decides when prose is stale
// (docs/proposals/changes-page.md 7.2). Convex's default runtime has no node
// crypto, so both ride two 32-bit lanes for a 64-bit value: the FNV-1a the
// inbox digest already uses, and a multiply-xorshift lane beside it.
import { fnv1a32Update, FNV1A32_OFFSET } from "../contracts/inboxProjection";

/**
 * FNV-1a's multiply only carries upward, so its low bits are fixed by the
 * low bits of the input (bit 0 is a parity of the characters). This lane folds
 * high bits back down after every character, so a pair that collides in FNV
 * has no structural reason to collide here too.
 */
function shiftLane(s: string): number {
  let h = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

/** 16 hex chars over the parts, joined with a separator no id contains. */
export function hash64(parts: readonly string[]): string {
  const s = parts.join("\u001f");
  const a = fnv1a32Update(FNV1A32_OFFSET, s);
  const b = shiftLane(s);
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
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
