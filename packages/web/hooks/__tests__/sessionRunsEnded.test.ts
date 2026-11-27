// A session's Ship that ended outside its feed's window (convex sessionFlowRuns.forConversation answers every live
// run and only the newest three ended ones): the store still holds it live, the session feeder asks for it by id, and
// the row heals to ended, so the session's chip stops offering Stop on a finished run.
import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { applyCollectionFeed } from "../useSyncCollection";
import { sessionRunsEndedOutOfWindow } from "../useSyncWorkflows";

const CONV = "jx7sessionaaaaaaaaaaaaaaaaaaaaaa";
const id = (n: number) => `th7${String(n).padStart(29, "a")}`;
const run = (n: number, status: string, extra: Record<string, unknown> = {}) => ({
  _id: id(n), spawner_conversation_id: CONV, status, takes_change: true, created_at: n, updated_at: n, node_statuses: [], ...extra,
});
const runs = () => (useInboxStore.getState() as any).workflowRuns as Record<string, any>;

describe("a session's run that ended outside its feed's window", () => {
  beforeEach(() => {
    useInboxStore.setState({ workflowRuns: {}, pending: {} } as any);
  });

  it("is asked for by id, and heals from running to completed", () => {
    // The store saw run 1 while it ran at CI; four later Ships ended after it, so the feed names those and not run 1.
    useInboxStore.getState().syncTable("workflowRuns", [run(1, "running", { current_node_id: "ci" })], { isDelta: true });
    const answer = [run(5, "completed"), run(4, "completed"), run(3, "completed")];
    applyCollectionFeed("workflowRuns", answer);
    expect(runs()[id(1)].status).toBe("running");
    expect(sessionRunsEndedOutOfWindow(runs(), CONV, answer)).toEqual([id(1)]);
    // byIds answers the run as it is now.
    applyCollectionFeed("workflowRuns", [run(1, "completed", { current_node_id: "exit", updated_at: 9 })]);
    expect(runs()[id(1)].status).toBe("completed");
    expect(sessionRunsEndedOutOfWindow(runs(), CONV, answer)).toEqual([]);
  });

  it("leaves alone a live run the feed names, an ended one, another session's and a made-up id", () => {
    const held = {
      [id(1)]: run(1, "running"),
      [id(2)]: run(2, "completed"),
      [id(3)]: { ...run(3, "paused"), spawner_conversation_id: "jx7otheraaaaaaaaaaaaaaaaaaaaaaaa" },
      stubrun: { ...run(4, "running"), _id: "stubrun" },
      [id(5)]: run(5, "paused"),
    };
    expect(sessionRunsEndedOutOfWindow(held, CONV, [run(1, "running")])).toEqual([id(5)]);
  });
});
