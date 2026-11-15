// A board, sheet or dashboard opens at once on a placeholder doc id (lib/createLiveArtifact), before the
// server has made the doc. Writes to it stay in this tab's store until the real id is known; nothing is
// sent and nothing is asked of the server under the placeholder.
import { isConvexId } from "../../lib/entityLinks";

/** A placeholder doc id: minted here, never a server id. */
export function newStubDocId(): string {
  return `docstub-${Math.random().toString(36).slice(2, 12)}`;
}

/** Whether the server has not made this doc yet (its id is a placeholder). */
export function isStubDoc(docId: string): boolean {
  return !!docId && !isConvexId(docId);
}
