// A board, sheet or dashboard opens at once on a placeholder doc id (lib/createLiveArtifact), before the
// server has made the doc. Writes to it stay in this tab's store until the real id is known; nothing is
// sent and nothing is asked of the server under the placeholder.

const STUB_PREFIX = "docstub-";

/** A placeholder doc id: minted here, never a server id. */
export function newStubDocId(): string {
  return `${STUB_PREFIX}${Math.random().toString(36).slice(2, 12)}`;
}

/** Whether this is a placeholder this code minted (any other id is the server's, or a test's, to answer for). */
export function isStubDoc(docId: string): boolean {
  return typeof docId === "string" && docId.startsWith(STUB_PREFIX);
}
