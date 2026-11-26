import { describe, expect, test } from "bun:test";

// An inbox card reads its session's ship state through a signature string
// (useSessionShipState sessionShipSig / sessionShipFromSig). Whatever the card's
// chip needs to link into the Deploys page has to survive that round trip: the
// commit a run landed and the run's team, not only the words and the deploy.

const { sessionShipSig, sessionShipFromSig } = await import("../useSessionShipState");

const SHA = "a0de449540f0a6545c78d050748211d78013c039";

describe("a card's ship signature", () => {
  test("carries the landed commit and team, so the chip opens that team's Deploys page at the commit", () => {
    const landed = { _id: "r1", spawner_conversation_id: "c1", takes_change: true, status: "completed", created_at: 1, workspace: "team:T1", current_node_id: "exit", merge: { sha: SHA }, node_statuses: [{ node_id: "land__ship", status: "completed" }] };
    const state: any = { workflowRuns: { r1: landed }, teamDeploys: {}, deployReach: {}, clientState: { ui: { active_team_id: "T1" } }, currentUser: null, sessionDecisions: {} };
    const ship = sessionShipFromSig(sessionShipSig(state, "c1"));
    expect(ship).toMatchObject({ words: "Merged", run: "r1", sha: SHA, team: "T1", deploy: null });
  });

  test("an empty signature is no ship, and one without a commit reads back with none", () => {
    expect(sessionShipFromSig("")).toBeNull();
    expect(sessionShipFromSig("working\u0000Review\u0000\u0000r2")).toEqual({ tone: "working", words: "Review", deploy: null, run: "r2", sha: null, team: null });
  });
});
