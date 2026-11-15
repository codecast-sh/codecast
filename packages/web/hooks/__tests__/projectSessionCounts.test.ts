import { describe, expect, it } from "bun:test";
import { countsDigest } from "../useProjectSessionCounts";

const row = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, session_id: id, updated_at: 1, ...extra });

describe("project session counts", () => {
  it("counts only the projects asked about, and reuses the answer while the sessions are unchanged", () => {
    const sessions = Object.fromEntries([row("a", { project_id: "p1" }), row("b", { project_id: "p2" }), row("c", { parent_conversation_id: "a" })].map((s) => [s._id, s]));
    const state = { sessions, tasks: {}, plans: {} };
    const memo = { current: null as any };
    const digest = countsDigest(state, "p1", new Set(["p1"]), 0, memo);
    expect(digest.startsWith("p1=")).toBe(true);
    expect(digest).not.toContain("p2");
    expect(digest.split("=")[1].split(",").reduce((n, kv) => n + Number(kv.split(":")[1]), 0)).toBe(2);
    const first = memo.current;
    expect(countsDigest(state, "p1", new Set(["p1"]), 0, memo)).toBe(digest);
    expect(memo.current).toBe(first);
  });
});
