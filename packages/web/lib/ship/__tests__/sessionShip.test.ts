import { describe, expect, test } from "bun:test";
import { landedShas, reachShip, reachTargets, runShip, sessionShips, shipHref } from "../sessionShip";

const SHA = "a0de449540f0a6545c78d050748211d78013c039";
const target = (name: string, state: string, over: Record<string, unknown> = {}) => ({ target: name, state, deploy: null, now: null, ...over }) as any;
const run = (id: string, conv: string, over: Record<string, unknown>) => ({ _id: id, spawner_conversation_id: conv, takes_change: true, status: "running", created_at: 1, ...over }) as any;
const dp = (id: string, status: string, sessions: string[], at: number, target = "backend") => ({ _id: id, short_id: id, status, target, sessions: sessions.map((c) => ({ conversation_id: c })), created_at: at, live_at: status === "live" ? at : null }) as any;

describe("runShip", () => {
  test("each place a run stands reads as a card's words, from the station's own label", () => {
    expect(runShip(run("r", "c", { current_node_id: "review", current_node_label: "Review" }))).toMatchObject({ words: "Review", tone: "working" });
    expect(runShip(run("r", "c", { current_node_id: "brief", current_node_label: "Fix findings", waiting_on_session: { node_id: "brief" } }))).toMatchObject({ words: "Fixing", tone: "session" });
    // The session pinned blocked: the run waits for a person, never a stop.
    expect(runShip(run("r", "c", { current_node_id: "brief", current_node_label: "Fix findings", waiting_on_session: { node_id: "brief", blocked: true } }))).toMatchObject({ words: "Waiting for a person", tone: "wait" });
    // The session asks the viewer with a card: the chip says so, and once it is answered the session is fixing again (ct-99051).
    const asks = run("r", "c", { current_node_id: "brief", waiting_on_session: { node_id: "brief", conversation_id: "c", since: 100, blocked: true }, node_statuses: [{ node_id: "brief", status: "running", started_at: 50 }] });
    const ask = { id: "d1", short_id: null, question: "Keep it?", mine: true, open: true };
    expect(runShip(asks, "u1", null, ask)).toMatchObject({ words: "Waiting on you", tone: "you" });
    expect(runShip(asks, "u1", null, { ...ask, open: false })).toMatchObject({ words: "Fixing", tone: "session" });
    // The inbox map finds the card in the viewer's decisions itself.
    const decisions = { d1: { _id: "d1", conversation_id: "c", question: "Keep it?", status: "pending", blocking: true, user_id: "u1", created_at: 60 } };
    expect(sessionShips([asks], [], {}, "u1", decisions as any).get("c")).toMatchObject({ words: "Waiting on you", tone: "you" });
    expect(sessionShips([asks], [], {}, "u1", { d1: { ...decisions.d1, status: "answered", resolved_at: 120 } } as any).get("c")).toMatchObject({ words: "Fixing" });
    expect(runShip(run("r", "c", { status: "completed", current_node_id: "exit", node_statuses: [{ node_id: "deploy__wait", status: "completed" }] }))).toMatchObject({ words: "Live", tone: "ok" });
    // A flow that ends at Land leaves its change on main: finishing it is not going live.
    expect(runShip(run("r", "c", { status: "completed", current_node_id: "exit", merge: { sha: SHA }, node_statuses: [{ node_id: "land__ship", status: "completed" }] }))).toMatchObject({ words: "Merged", tone: "ok" });
    expect(runShip(run("r", "c", { status: "failed", current_node_id: "unshipped", current_node_label: "Not merged" }))).toMatchObject({ words: "Stopped · Not merged", tone: "bad" });
    expect(runShip(run("r", "c", { status: "failed", current_node_id: "deploy__failed", fail_reason: "Stopped: The deploy that carried abc failed: web dp-9 (x)." }))).toMatchObject({ words: "Deploy failed" });
    expect(runShip(run("r", "c", { status: "failed", current_node_id: "deploy__failed", fail_reason: "Stopped: No deploy took abc out: cli dp-9 stopped at Send before sending anything (x)." }))).toMatchObject({ words: "Not sent", tone: "bad" });
  });
  test("an open card says Your call only to someone who may answer it, the run card's rule", () => {
    const gate = run("r", "c", { status: "paused", user_id: "u1", current_node_id: "decide__decide", gate_decision_id: "d1" });
    expect(runShip(gate, "u1", { user_id: "u1", holder: { kind: "user", id: "u1" } })).toMatchObject({ words: "Your call", tone: "you" });
    expect(runShip(gate, "u1", { user_id: "u0", asked_user_ids: ["u0", "u1"] })).toMatchObject({ words: "Your call" });
    expect(runShip(gate, "u1", { user_id: "u1", holder: { kind: "role", id: "r1" } })).toMatchObject({ words: "Waiting for approval", tone: "wait" });
    // The run's owner is not who answers: with no card known, never "Your call".
    expect(runShip(gate, "u1")).toMatchObject({ words: "Waiting for approval" });
    expect(runShip({ ...gate, gate_decision_status: "answered" }, "u1", { user_id: "u1" })?.words).not.toBe("Your call");
  });
  test("at Deploy, only a merged sha on the run means the change landed", () => {
    // A run at Deploy with no merge recorded (merged by its own script, an older CLI) shows its wait, never Not merged.
    expect(runShip(run("r", "c", { current_node_id: "deploy__wait" }))).toMatchObject({ words: "Waiting to deploy", tone: "wait" });
    expect(runShip(run("r", "c", { current_node_id: "deploy__wait", node_statuses: [{ node_id: "deploy__wait", started_at: 5, result_preview: "backend: dp-13 sending 4a6e413 (6m of 60m)" }] }))).toMatchObject({ words: "Deploying", tone: "working" });
    // Not merged only for a run that ended at Deploy with no merge on it.
    expect(runShip(run("r", "c", { status: "failed", current_node_id: "deploy__unmerged", current_node_label: "Not merged" }))).toMatchObject({ words: "Not merged", tone: "bad" });
    // Deploying only while a deploy carries it, as the Deploy line says; the run card reads the same words.
    const at = (line: string) => run("r", "c", { current_node_id: "deploy__wait", merge: { sha: "abc" }, node_statuses: [{ node_id: "deploy__wait", started_at: 5, result_preview: line }] });
    expect(runShip(at("backend: dp-13 sending 4a6e413 (6m of 60m)"))).toMatchObject({ words: "Deploying", tone: "working" });
    expect(runShip(at("backend: waiting on main CI at 9f8e7d6 (red since 1a2b3c4: test-web; held 2m, then 45m)"))).toMatchObject({ words: "Waiting for green main", tone: "wait" });
    expect(runShip(at("backend: waiting on main CI at 9f8e7d6 (running; held 2m, then 45m)"))).toMatchObject({ words: "Waiting on main CI", tone: "wait" });
    expect(runShip(at("web: waiting for the server to send 4a6e413 once main CI is green (held 3m, then 30m)"))).toMatchObject({ words: "Waiting on main CI", tone: "wait" });
    expect(runShip(at("web: waiting for Release Captain to send it (held 3m, then 1d)"))).toMatchObject({ words: "Waiting for Release Captain to deploy", tone: "wait" });
    expect(runShip(run("r", "c", { current_node_id: "deploy__wait", merge: { sha: "abc" } }))).toMatchObject({ words: "Waiting to deploy", tone: "wait" });
    expect(runShip(run("r", "c", { status: "completed", current_node_id: "ship__landed" }))).toMatchObject({ words: "Done", tone: "ok" });
    expect(runShip(run("r", "c", { status: "completed", current_node_id: "ship__landed", merge: { sha: "abc" } }))).toMatchObject({ words: "Merged", tone: "ok" });
  });
});

describe("sessionShips", () => {
  test("a run in flight wins; a session with no run says where its commits went out", () => {
    const m = sessionShips(
      [run("r1", "a", { current_node_id: "review", current_node_label: "Review" }), run("r2", "b", { status: "completed", current_node_id: "exit", node_statuses: [{ node_id: "deploy", status: "completed" }] }), run("r3", "e", { status: "paused", user_id: "u1", gate_decision_id: "d3" })],
      [dp("dp-1", "live", ["a", "b", "c"], 5), dp("dp-2", "failed", ["d"], 6), dp("dp-3", "live", ["d"], 4)],
      {},
      "u1",
      { d3: { user_id: "u1" } },
    );
    expect(m.get("a")?.words).toBe("Review");
    expect(m.get("b")).toMatchObject({ words: "Live · backend", deploy: "dp-1" });
    expect(m.get("c")).toMatchObject({ words: "Live · backend" });
    expect(m.get("d")).toMatchObject({ words: "Deploy failed · backend", tone: "bad" });
    expect(m.get("e")).toMatchObject({ words: "Your call", tone: "you" });
    expect(m.get("f")).toBeUndefined();
  });
});

describe("a landed change reads where the deploy records put it", () => {
  const landed = run("r", "s", { status: "completed", current_node_id: "exit", merge: { sha: SHA }, node_statuses: [{ node_id: "land__ship", status: "completed" }] });
  // Production live on a deploy that does not hold the change; aivery-operator dormant.
  const waiting = { state: "waiting", targets: [target("aivery-operator", "waiting", { dormant: true }), target("production", "waiting", { now: { short_id: "dp-2232" } })] } as any;

  test("not live yet names the target still shipping, never a dormant one", () => {
    expect(reachShip(waiting, "r")).toEqual({ words: "Not live yet · production", tone: "wait", deploy: null, run: "r", sha: null, team: null });
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

  test("without a reach yet the card says Merged, and the feeder asks for the newest landed commit of each session", () => {
    expect(sessionShips([landed], []).get("s")).toMatchObject({ words: "Merged" });
    const older = run("o", "s", { status: "completed", created_at: 0, merge: { sha: "b".repeat(40) } });
    const live = run("l", "t", { status: "completed", merge: { sha: "c".repeat(40) }, node_statuses: [{ node_id: "deploy", status: "completed" }] });
    expect(landedShas([older, landed, live])).toEqual([SHA]);
  });
});

describe("a landed run is never relabeled by an older deploy", () => {
  test("its commit unread yet, a deploy of the session's earlier commits does not make it Live", () => {
    const landed = run("r", "s", { status: "completed", created_at: 10, updated_at: 12, merge: { sha: SHA }, node_statuses: [{ node_id: "land__ship", status: "completed" }] });
    expect(sessionShips([landed], [dp("dp-1", "live", ["s"], 20, "production")]).get("s")).toMatchObject({ words: "Merged", tone: "ok" });
  });

  test("a run that named no commit takes only a deploy made after it ended", () => {
    const ended = run("r", "s", { status: "completed", created_at: 10, updated_at: 12 });
    // With no merge recorded the run says it finished and claims nothing; a later deploy still says where it went.
    expect(sessionShips([ended], [dp("dp-1", "live", ["s"], 5, "production")]).get("s")).toMatchObject({ words: "Done" });
    expect(sessionShips([ended], [dp("dp-2", "live", ["s"], 20, "production")]).get("s")).toMatchObject({ words: "Live · production", deploy: "dp-2" });
  });
});

test("a session's run of a flow that carries no change (an eval, a deploy) is not its ship", () => {
  const change = run("r1", "s", { status: "completed", created_at: 1, merge: { sha: "a".repeat(40) } });
  const evalRun = run("r2", "s", { status: "running", created_at: 2, takes_change: false, current_node_id: "judge" });
  expect(sessionShips([change, evalRun], []).get("s")).toMatchObject({ words: "Merged", run: "r1" });
  expect(landedShas([change, evalRun])).toEqual(["a".repeat(40)]);
});

describe("a card's ship word opens the Deploys page", () => {
  test("at its deploy, else at the commit it landed, else nowhere", () => {
    expect(shipHref({ deploy: "dp-9", sha: SHA })).toBe("/deploys?deploy=dp-9");
    // Deploys belong to a team: a personal run's commit has no page to open.
    expect(shipHref({ deploy: null, sha: SHA })).toBeNull();
    // On the run's own team, so a viewer in another workspace still lands on the page that holds it.
    expect(shipHref({ sha: SHA.toUpperCase(), team: "T1" })).toBe(`/deploys?team=T1&sha=${SHA}`);
    expect(shipHref({})).toBeNull();
    // A landed run's words carry its commit, whether they come from the run or from the reach that answered for it.
    const landed = run("r", "c", { status: "completed", current_node_id: "exit", merge: { sha: SHA }, node_statuses: [{ node_id: "land__ship", status: "completed" }] });
    expect(runShip(landed)?.sha).toBe(SHA);
    expect(runShip({ ...landed, workspace: "team:T1" })).toMatchObject({ sha: SHA, team: "T1" });
    const waiting = { state: "waiting", targets: [target("production", "waiting")] } as any;
    expect(sessionShips([landed], [], { [SHA]: waiting }).get("c")).toMatchObject({ words: "Not live yet · production", sha: SHA });
  });
});
