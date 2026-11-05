import { describe, expect, test } from "bun:test";
import { runShip, sessionShips } from "../sessionShip";

const run = (id: string, conv: string, over: Record<string, unknown>) => ({ _id: id, spawner_conversation_id: conv, status: "running", created_at: 1, ...over }) as any;
const dp = (id: string, status: string, sessions: string[], at: number, target = "backend") => ({ _id: id, short_id: id, status, target, sessions: sessions.map((c) => ({ conversation_id: c })), created_at: at, live_at: status === "live" ? at : null }) as any;

describe("runShip", () => {
  test("each place a run stands reads as a card's words", () => {
    expect(runShip(run("r", "c", { current_node_id: "review__review" }))).toMatchObject({ words: "In review", tone: "agent" });
    expect(runShip(run("r", "c", { status: "paused", current_node_id: "decide__decide" }))).toMatchObject({ words: "Your call", tone: "you" });
    expect(runShip(run("r", "c", { current_node_id: "fix_check", waiting_on_session: { node_id: "fix_check" } }))).toMatchObject({ words: "Fixing · Check", tone: "session" });
    expect(runShip(run("r", "c", { current_node_id: "deploy__wait" }))).toMatchObject({ words: "Waiting to deploy" });
    expect(runShip(run("r", "c", { status: "completed", current_node_id: "exit" }))).toMatchObject({ words: "Live", tone: "ok" });
    expect(runShip(run("r", "c", { status: "failed", current_node_id: "deploy__failed", fail_reason: "Stopped: The deploy that carried abc failed: web dp-9 (x)." }))).toMatchObject({ words: "Deploy failed" });
  });
});

describe("sessionShips", () => {
  test("a run in flight wins; a session with no run says where its commits went out", () => {
    const m = sessionShips(
      [run("r1", "a", { current_node_id: "review__review" }), run("r2", "b", { status: "completed", current_node_id: "exit" })],
      [dp("dp-1", "live", ["a", "b", "c"], 5), dp("dp-2", "failed", ["d"], 6), dp("dp-3", "live", ["d"], 4)],
    );
    expect(m.get("a")?.words).toBe("In review");
    expect(m.get("b")).toMatchObject({ words: "Live · dp-1", deploy: "dp-1" });
    expect(m.get("c")).toMatchObject({ words: "Live · dp-1" });
    expect(m.get("d")).toMatchObject({ words: "Deploy failed · backend", tone: "bad" });
    expect(m.get("e")).toBeUndefined();
  });
});
