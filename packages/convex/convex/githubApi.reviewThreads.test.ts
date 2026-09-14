// Resolving a review thread lives only in GitHub's GraphQL API, keyed by a
// thread id the REST comment never carries. The action finds the thread by
// the comment's database id, skips the mutation when the thread already
// stands as asked, and hands the id back for caching.
import { describe, expect, test } from "bun:test";
import { setReviewThreadResolved } from "./githubApi";

function stubGraphQL(answers: Array<(body: any) => any>, calls: any[]) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answer = answers.shift();
    return { ok: true, status: 200, async json() { return { data: answer ? answer(body) : {} }; }, async text() { return ""; } } as any;
  }) as any;
  return () => { globalThis.fetch = real; };
}

const threadsPage = (nodes: any[], hasNext = false) => ({
  repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? "c1" : null }, nodes } } },
});

describe("setReviewThreadResolved", () => {
  test("finds the thread by comment id, resolves it, and returns the id", async () => {
    const calls: any[] = [];
    const restore = stubGraphQL([
      () => threadsPage([
        { id: "T_a", isResolved: false, comments: { nodes: [{ databaseId: 1 }] } },
        { id: "T_b", isResolved: false, comments: { nodes: [{ databaseId: 501 }, { databaseId: 502 }] } },
      ]),
      () => ({ resolveReviewThread: { thread: { id: "T_b", isResolved: true } } }),
    ], calls);
    try {
      const out = await (setReviewThreadResolved as any)._handler({}, {
        repository: "codecast-sh/codecast", pr_number: 12, github_comment_id: 502, resolved: true, github_access_token: "t",
      });
      expect(out).toEqual({ thread_id: "T_b", changed: true });
      expect(calls[1].query).toContain("resolveReviewThread");
      expect(calls[1].variables).toEqual({ id: "T_b" });
    } finally { restore(); }
  });

  test("a cached thread id skips the walk, and a thread already as asked skips the mutation", async () => {
    const calls: any[] = [];
    const restore = stubGraphQL([
      () => ({ node: { id: "T_b", isResolved: true } }),
    ], calls);
    try {
      const out = await (setReviewThreadResolved as any)._handler({}, {
        repository: "codecast-sh/codecast", pr_number: 12, thread_id: "T_b", resolved: true, github_access_token: "t",
      });
      expect(out).toEqual({ thread_id: "T_b", changed: false });
      expect(calls).toHaveLength(1);
    } finally { restore(); }
  });

  test("unresolving uses the other mutation and walks a second page when needed", async () => {
    const calls: any[] = [];
    const restore = stubGraphQL([
      () => threadsPage([{ id: "T_a", isResolved: true, comments: { nodes: [{ databaseId: 1 }] } }], true),
      () => threadsPage([{ id: "T_z", isResolved: true, comments: { nodes: [{ databaseId: 9 }] } }]),
      () => ({ unresolveReviewThread: { thread: { id: "T_z", isResolved: false } } }),
    ], calls);
    try {
      const out = await (setReviewThreadResolved as any)._handler({}, {
        repository: "codecast-sh/codecast", pr_number: 12, github_comment_id: 9, resolved: false, github_access_token: "t",
      });
      expect(out).toEqual({ thread_id: "T_z", changed: true });
      expect(calls[1].variables.after).toBe("c1");
      expect(calls[2].query).toContain("unresolveReviewThread");
    } finally { restore(); }
  });

  test("a comment GitHub holds in no thread answers null and mutates nothing", async () => {
    const calls: any[] = [];
    const restore = stubGraphQL([() => threadsPage([])], calls);
    try {
      const out = await (setReviewThreadResolved as any)._handler({}, {
        repository: "codecast-sh/codecast", pr_number: 12, github_comment_id: 77, resolved: true, github_access_token: "t",
      });
      expect(out).toEqual({ thread_id: null, changed: false });
      expect(calls).toHaveLength(1);
    } finally { restore(); }
  });
});
