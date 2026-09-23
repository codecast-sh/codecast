// The repair unlinks only commits a merge handed to the session on the branch,
// and keeps every link that has its own evidence.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { unlinkMergedCommits } from "./migrations";

const CONV = "conv_1";
const FEATURE = "aivery/cold-email";
const sha = (c: string) => c.repeat(40);

function context() {
  return {
    db: makeFakeDb({
      conversations: [{ _id: CONV, git_branch: FEATURE }],
      commits: [
        // main's commit, first stored by main's push, claimed later by a merge push.
        { _id: "c_merged", sha: sha("a"), branch: "main", conversation_id: CONV },
        // The session's own commit, proven by its edit row.
        { _id: "c_recorded", sha: sha("b"), branch: "main", conversation_id: CONV },
        // A commit the branch rule linked when it was first pushed.
        { _id: "c_branch", sha: sha("c"), branch: FEATURE, conversation_id: CONV },
        // A commit the daemon linked after the webhook recorded it unlinked.
        { _id: "c_daemon", sha: sha("d"), branch: FEATURE, conversation_id: CONV },
      ],
      file_changes: [{ _id: "fc_1", conversation_id: CONV, commit_hash: sha("b").slice(0, 7) }],
      external_events: [
        { _id: "e_a", dedupe_key: `commit:${sha("a")}` },
        { _id: "e_b", dedupe_key: `commit:${sha("b")}` },
        { _id: "e_c", dedupe_key: `commit:${sha("c")}`, conversation_id: CONV },
        { _id: "e_d", dedupe_key: `commit:${sha("d")}` },
      ],
    }),
    scheduler: { async runAfter() {} },
  } as any;
}

const linked = (ctx: any, id: string) => ctx.db._tables.commits.find((c: any) => c._id === id).conversation_id;

describe("unlinkMergedCommits", () => {
  test("a dry run counts the merged commit and changes nothing", async () => {
    const ctx = context();
    const result = await (unlinkMergedCommits as any)._handler(ctx, {});
    expect(result).toMatchObject({ dryRun: true, scanned: 4, unlinked: 1 });
    expect(linked(ctx, "c_merged")).toBe(CONV);
  });

  test("unlinks only the commit a merge handed over", async () => {
    const ctx = context();
    await (unlinkMergedCommits as any)._handler(ctx, { dryRun: false });
    expect(linked(ctx, "c_merged")).toBeUndefined();
    expect(linked(ctx, "c_recorded")).toBe(CONV);
    expect(linked(ctx, "c_branch")).toBe(CONV);
    expect(linked(ctx, "c_daemon")).toBe(CONV);
  });
});
