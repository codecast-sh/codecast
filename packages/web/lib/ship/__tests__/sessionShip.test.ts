import { describe, expect, test } from "bun:test";
import { landedShas, reachShip, reachTargets, runShip, sessionShips } from "../sessionShip";

const SHA = "a0de449540f0a6545c78d050748211d78013c039";
const target = (name: string, state: string, over: Record<string, unknown> = {}) => ({ target: name, state, deploy: null, now: null, ...over }) as any;
const run = (id: string, conv: string, over: Record<string, unknown>) => ({ _id: id, spawner_conversation_id: conv, status: "running", created_at: 1, ...over }) as any;
const dp = (id: string, status: string, sessions: string[], at: number, target = "backend") => ({ _id: id, short_id: id, status, target, sessions: sessions.map((c) => ({ conversation_id: c })), created_at: at, live_at: status === "live" ? at : null }) as any;

describe("runShip", () => {
  test("each place a run stands reads as a card's words", () => {
    expect(runShip(run("r", "c", { current_node_id: "review__review" }))).toMatchObject({ words: "In review", tone: "agent" });
    expect(runShip(run("r", "c", { status: "paused", current_node_id: "decide__decide" }))).toMatchObject({ words: "Your call", tone: "you" });
    expect(runShip(run("r", "c", { current_node_id: "fix_check", waiting_on_session: { node_id: "fix_check" } }))).toMatchObject({ words: "Check failed · fixing", tone: "session" });
    expect(runShip(run("r", "c", { current_node_id: "deploy__wait" }))).toMatchObject({ words: "Waiting to deploy" });
    expect(runShip(run("r", "c", { status: "completed", current_node_id: "exit", node_statuses: [{ node_id: "deploy__wait", status: "completed" }] }))).toMatchObject({ words: "Live", tone: "ok" });
    // A flow that ends at Land leaves its change on main: finishing it is not going live.
    expect(runShip(run("r", "c", { status: "completed", current_node_id: "exit", merge: { sha: SHA }, node_statuses: [{ node_id: "land__ship", status: "completed" }] }))).toMatchObject({ words: "Landed", tone: "ok" });
    expect(runShip(run("r", "c", { status: "failed", current_node_id: "review__changes" }))).toMatchObject({ words: "Stopped · Review", tone: "bad" });
    expect(runShip(run("r", "c", { status: "failed", current_node_id: "fix_review" }))).toMatchObject({ words: "Stopped · Review" });
    expect(runShip(run("r", "c", { status: "failed", current_node_id: "deploy__failed", fail_reason: "Stopped: The deploy that carried abc failed: web dp-9 (x)." }))).toMatchObject({ words: "Deploy failed" });
  });
});

describe("sessionShips", () => {
  test("a run in flight wins; a session with no run says where its commits went out", () => {
    const m = sessionShips(
      [run("r1", "a", { current_node_id: "review__review" }), run("r2", "b", { status: "completed", current_node_id: "exit", node_statuses: [{ node_id: "deploy", status: "completed" }] })],
      [dp("dp-1", "live", ["a", "b", "c"], 5), dp("dp-2", "failed", ["d"], 6), dp("dp-3", "live", ["d"], 4)],
    );
    expect(m.get("a")?.words).toBe("In review");
    expect(m.get("b")).toMatchObject({ words: "Live · backend", deploy: "dp-1" });
    expect(m.get("c")).toMatchObject({ words: "Live · backend" });
    expect(m.get("d")).toMatchObject({ words: "Deploy failed · backend", tone: "bad" });
    expect(m.get("e")).toBeUndefined();
  });
});

describe("a landed change reads where the deploy records put it", () => {
  const landed = run("r", "s", { status: "completed", current_node_id: "exit", merge: { sha: SHA }, node_statuses: [{ node_id: "land__ship", status: "completed" }] });
  // Production live on a deploy that does not hold the change; aivery-operator dormant.
  const waiting = { state: "waiting", targets: [target("aivery-operator", "waiting", { dormant: true }), target("production", "waiting", { now: { short_id: "dp-2232" } })] } as any;

  test("not live yet names the target still shipping, never a dormant one", () => {
    expect(reachShip(waiting, "r")).toEqual({ words: "Not live yet · production", tone: "wait", deploy: null, run: "r" });
    expect(reachTargets(waiting)).toEqual([{ name: "production", state: "waiting", deploy: null, at: null }]);
  });

  test("each reach state has its words, and a live or failed one opens its deploy", () => {
    const one = (state: string, deploy?: string) => reachShip({ state, targets: [target("production", state, deploy ? { deploy: { short_id: deploy, at: 9 } } : {})] } as any);
    expect(one("live", "dp-9")).toMatchObject({ words: "Live · production", tone: "ok", deploy: "dp-9" });
    expect(one("going_out", "dp-9")).toMatchObject({ words: "Deploying · production", tone: "working" });
    expect(one("queued", "dp-9")).toMatchObject({ words: "Deploy queued · production", tone: "working" });
    expect(one("failed", "dp-9")).toMatchObject({ words: "Deploy failed · production", tone: "bad", deploy: "dp-9" });
    expect(one("rolled_back", "dp-8")).toMatchObject({ words: "Rolled back · production", tone: "bad" });
  });

  test("the session's card takes the reach over its run and over an older deploy of its commits", () => {
    const m = sessionShips([landed], [dp("dp-1", "live", ["s"], 5, "production")], { [SHA]: waiting });
    expect(m.get("s")).toMatchObject({ words: "Not live yet · production", tone: "wait" });
  });

  test("without a reach yet the card says Landed, and the feeder asks for the newest landed commit of each session", () => {
    expect(sessionShips([landed], []).get("s")).toMatchObject({ words: "Landed" });
    const older = run("o", "s", { status: "completed", created_at: 0, merge: { sha: "b".repeat(40) } });
    const live = run("l", "t", { status: "completed", merge: { sha: "c".repeat(40) }, node_statuses: [{ node_id: "deploy", status: "completed" }] });
    expect(landedShas([older, landed, live])).toEqual([SHA]);
  });
});

describe("a landed run is never relabeled by an older deploy", () => {
  test("its commit unread yet, a deploy of the session's earlier commits does not make it Live", () => {
    const landed = run("r", "s", { status: "completed", created_at: 10, updated_at: 12, merge: { sha: SHA }, node_statuses: [{ node_id: "land__ship", status: "completed" }] });
    expect(sessionShips([landed], [dp("dp-1", "live", ["s"], 20, "production")]).get("s")).toMatchObject({ words: "Landed", tone: "ok" });
  });

  test("a run that named no commit takes only a deploy made after it ended", () => {
    const ended = run("r", "s", { status: "completed", created_at: 10, updated_at: 12 });
    expect(sessionShips([ended], [dp("dp-1", "live", ["s"], 5, "production")]).get("s")).toMatchObject({ words: "Landed" });
    expect(sessionShips([ended], [dp("dp-2", "live", ["s"], 20, "production")]).get("s")).toMatchObject({ words: "Live · production", deploy: "dp-2" });
  });
});
