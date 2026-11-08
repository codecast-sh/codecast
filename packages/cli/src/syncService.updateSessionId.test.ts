// The binding tells the server a cwd is outside any repo (not_a_repo), so it
// drops a git_root the web guessed. A server older than the CLI refuses the
// field and the whole call, and the binding itself must still land.
import { describe, expect, it } from "bun:test";
import { SyncService } from "./syncService.js";

function serviceAnswering(refuseNotARepo: boolean) {
  const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
  const calls: Record<string, unknown>[] = [];
  (sync as any).mutate = async (_fn: string, args: Record<string, unknown>) => {
    calls.push(args);
    if (refuseNotARepo && "not_a_repo" in args) {
      throw new Error("ArgumentValidationError: Object contains extra field `not_a_repo` that is not in the validator.");
    }
    return null;
  };
  return { sync, calls };
}

describe("SyncService.updateSessionId", () => {
  it("sends not_a_repo only when the cwd is outside a repo", async () => {
    const { sync, calls } = serviceAnswering(false);
    await sync.updateSessionId("c1", "s1", "/w", undefined, undefined, true);
    await sync.updateSessionId("c1", "s1", "/repo", "/repo");
    expect(calls[0]).toMatchObject({ session_id: "s1", project_path: "/w", not_a_repo: true });
    expect("not_a_repo" in calls[1]).toBe(false);
  });

  it("binds without the flag on a server that refuses it", async () => {
    const { sync, calls } = serviceAnswering(true);
    await sync.updateSessionId("c1", "s1", "/w", undefined, undefined, true);
    expect(calls).toHaveLength(2);
    expect("not_a_repo" in calls[1]).toBe(false);
    expect(calls[1]).toMatchObject({ conversation_id: "c1", session_id: "s1", project_path: "/w" });
  });
});
