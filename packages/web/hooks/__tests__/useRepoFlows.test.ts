// The session whose repository's own flows the Ship picker reads (hooks/useRepoFlows.ts): its origin remote comes from
// the conversation row when the sessions row lacks it, which it does for most sessions.
import { describe, expect, test } from "bun:test";
import { repositoryOfRemote, sessionRemoteOf } from "../useRepoFlows";

describe("a session's repository for the Ship picker", () => {
  test("a sessions row without a remote falls through to the conversation row", () => {
    const s = { sessions: { a: { git_root: "/x/union-mobile" } }, conversations: { a: { git_remote_url: "https://github.com/Union-AI/union-mobile.git" } } };
    expect(sessionRemoteOf(s, "a")).toBe("https://github.com/Union-AI/union-mobile.git");
    expect(repositoryOfRemote(sessionRemoteOf(s, "a"))?.toLowerCase()).toBe("union-ai/union-mobile");
  });

  test("the sessions row's own remote wins, and a session with none has no repository", () => {
    expect(sessionRemoteOf({ sessions: { a: { git_remote_url: "git@github.com:a/b.git" } }, conversations: { a: { git_remote_url: "git@github.com:c/d.git" } } }, "a")).toBe("git@github.com:a/b.git");
    expect(sessionRemoteOf({ sessions: {}, conversations: {} }, "a")).toBeNull();
    expect(repositoryOfRemote(null)).toBeNull();
  });
});
