// A CLI/API edit (docs.resetSync) rewrites a doc's collab history: it deletes
// every delta and stores the new content as a snapshot. A tab that opened the
// doc before the rewrite still holds the old content. Its steps used to be
// accepted as if they followed the rewrite, and every other editor then
// applied them to the new content and threw ProseMirror's
// "Invalid content for node paragraph" (2026-10-02).
import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { getSteps, latestVersion, submitSteps } from "./docSync";
import { resetSync } from "./docs";
import { DOC_REWRITTEN_ERROR } from "@codecast/shared/docs";

const OWNER = "u_owner";
const DOC = "doc_1";
const DOC_JSON = JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });

function world() {
  const t: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }],
    docs: [{ _id: DOC, user_id: OWNER, title: "Doc", content: "old" }],
    // The newest snapshot trails the deltas, as it does between compactions.
    doc_snapshots: [{ _id: "snap_1", id: DOC, version: 1, content: DOC_JSON }],
    doc_deltas: [
      { _id: "d_2", id: DOC, version: 2, clientId: "a", steps: ["old-1"] },
      { _id: "d_3", id: DOC, version: 3, clientId: "a", steps: ["old-2"] },
    ],
  };
  const db = makeFakeDb(t, { indexes: schemaIndexes(schema as any) });
  const origQuery = db.query.bind(db);
  // verifyApiToken looks the token up by hash; answer it with the owner.
  (db as any).query = (table: string) =>
    table === "api_tokens"
      ? { withIndex: () => ({ first: async () => ({ _id: "tok", user_id: OWNER }) }) }
      : origQuery(table);
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) },
    db,
    runMutation: async () => null,
    scheduler: { runAfter: async () => null },
  } as any;
  const run = (fn: any, args: any) => fn._handler(ctx, args);
  return { t, run };
}

describe("collab history across a CLI rewrite", () => {
  test("the rewrite lands past every version an open editor holds", async () => {
    const { t, run } = world();
    await run(resetSync, { api_token: "tok", id: DOC, content: "new body" });
    expect(t.doc_deltas).toEqual([]);
    expect(t.doc_snapshots.map((s) => s.version)).toEqual([4]);
    expect(await run(latestVersion, { id: DOC })).toBe(4);
  });

  test("a tab from before the rewrite cannot submit steps", async () => {
    const { t, run } = world();
    await run(resetSync, { api_token: "tok", id: DOC, content: "new body" });
    await expect(
      run(submitSteps, { id: DOC, version: 3, clientId: "a", steps: ["stale"] }),
    ).rejects.toThrow(DOC_REWRITTEN_ERROR);
    expect(t.doc_deltas).toEqual([]);
  });

  test("a stale tab is refused even after fresh editors have written", async () => {
    const { run } = world();
    await run(resetSync, { api_token: "tok", id: DOC, content: "new body" });
    expect(await run(submitSteps, { id: DOC, version: 4, clientId: "b", steps: ["new-1"] })).toEqual({
      status: "synced",
    });
    await expect(
      run(submitSteps, { id: DOC, version: 3, clientId: "a", steps: ["stale"] }),
    ).rejects.toThrow(DOC_REWRITTEN_ERROR);
    // Nor is it handed the new content's steps to replay on its old content;
    // an empty answer while the server is ahead is what remounts it (isSyncGap).
    expect(await run(getSteps, { id: DOC, version: 3 })).toEqual({ steps: [], clientIds: [], version: 3 });
    expect(await run(getSteps, { id: DOC, version: 4 })).toEqual({ steps: ["new-1"], clientIds: ["b"], version: 5 });
  });

  test("an unbroken history still rebases and replays as before", async () => {
    const { run } = world();
    expect(await run(submitSteps, { id: DOC, version: 2, clientId: "b", steps: ["x"] })).toEqual({
      status: "needs-rebase",
      steps: ["old-2"],
      clientIds: ["a"],
    });
    expect(await run(getSteps, { id: DOC, version: 1 })).toEqual({
      steps: ["old-1", "old-2"],
      clientIds: ["a", "a"],
      version: 3,
    });
    expect(await run(submitSteps, { id: DOC, version: 3, clientId: "b", steps: ["x"] })).toEqual({ status: "synced" });
  });
});
