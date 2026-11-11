// Comment threads of a live artifact: roots newest first, each with its
// replies oldest first. The comments panel and every product's pins group
// the comments layer through this one function.
import type { ArtifactElement } from "@codecast/shared/artifacts";

export type LiveThread = { root: ArtifactElement; replies: ArtifactElement[] };

export function groupThreads(comments: readonly ArtifactElement[]): LiveThread[] {
  const replies = new Map<string, ArtifactElement[]>();
  for (const c of comments) {
    if (typeof c.parent !== "string") continue;
    const list = replies.get(c.parent);
    if (list) list.push(c);
    else replies.set(c.parent, [c]);
  }
  const at = (c: ArtifactElement) => Number(c.created_at ?? c.at ?? 0);
  for (const list of replies.values()) list.sort((a, b) => at(a) - at(b));
  return comments
    .filter((c) => typeof c.parent !== "string")
    .sort((a, b) => at(b) - at(a))
    .map((root) => ({ root, replies: replies.get(root.key) ?? [] }));
}
