// The line workspace's action writes (line-workspace.md LW4): a step's save
// paints the drawn graph and a sessionCommands row; a try paints its cases
// queued, which the server rows supersede by their natural key; an ask
// paints its cause in progress. Each rides the dispatch of the same name.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { lineTryKey, lineTryStubId } from "../lineSlice";
import { taskStubId } from "../taskStub";

const s = () => useInboxStore.getState() as any;
const ME = "u".repeat(32);
const WF = "w".repeat(32);
const RUN = "r".repeat(32);
const TASK = "k".repeat(32);
const PROJECT = "p".repeat(32);

let calls: Array<[string, unknown[]]> = [];
const owner = {};
beforeAll(() => s()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  calls = [];
  useInboxStore.setState({
    lineTries: {}, sessionCommands: {}, pending: {}, tasks: {}, currentUser: { _id: ME },
    workflows: { [WF]: { _id: WF, user_id: ME, slug: "agentwatch", nodes: [{ id: "investigate", prompt: "old" }] } },
    workflowRuns: { [RUN]: { _id: RUN, task_id: TASK } },
  } as any);
});
const settle = async () => { for (let i = 0; i < 100 && calls.length === 0; i++) await Bun.sleep(2); };

describe("editLineGraph", () => {
  it("paints the step's new text and a save row, and sends the save", async () => {
    void s().editLineGraph("req1", WF, { node: "investigate", text: "new", base_hash: "abcd" }).catch(() => {});
    expect(s().workflows[WF].nodes[0].prompt).toBe("new");
    expect(s().sessionCommands.req1).toMatchObject({ kind: "line_graph_edit", workflow_id: WF, node: "investigate", text: "new", executed_at: null });
    await settle();
    expect(calls[0]).toEqual(["editLineGraph", ["req1", WF, { node: "investigate", text: "new", base_hash: "abcd" }]]);
  });

  it("on a teammate's graph, paints the viewer's own push of it, never the teammate's row", () => {
    const MATE_WF = "m".repeat(32);
    useInboxStore.setState({
      workflows: {
        [MATE_WF]: { _id: MATE_WF, user_id: "t".repeat(32), slug: "agentwatch", nodes: [{ id: "investigate", prompt: "old" }] },
        [WF]: { _id: WF, user_id: ME, slug: "agentwatch", nodes: [{ id: "investigate", prompt: "old" }] },
      },
    } as any);
    void s().editLineGraph("req3", MATE_WF, { node: "investigate", text: "mine" }).catch(() => {});
    expect(s().workflows[MATE_WF].nodes[0].prompt).toBe("old");
    expect(s().workflows[WF].nodes[0].prompt).toBe("mine");
  });

  it("a second save of the step while the first travels keeps both rows", () => {
    void s().editLineGraph("req1", WF, { node: "investigate", text: "a" }).catch(() => {});
    void s().editLineGraph("req2", WF, { node: "investigate", text: "b" }).catch(() => {});
    expect(Object.keys(s().sessionCommands).sort()).toEqual(["req1", "req2"]);
  });
});

describe("tryLineStep", () => {
  it("paints each case queued in the project, and the server row supersedes the stub", async () => {
    void s().tryLineStep("t1", WF, { node: "investigate", text: "new", runs: [RUN], project_id: PROJECT }).catch(() => {});
    const key = lineTryKey("t1", RUN);
    expect(s().lineTries[lineTryStubId(key)]).toMatchObject({ key, status: "queued", project_id: PROJECT, case_id: TASK, node_id: "investigate", by: ME });
    await settle();
    expect(calls[0][0]).toBe("tryLineStep");
    s().syncTable("lineTries", [{ _id: "x".repeat(32), key, try_id: "t1", project_id: PROJECT, workflow_id: WF, node_id: "investigate", run_id: RUN, by: ME, at: 1, updated_at: 2, status: "running", old: {} }], { isDelta: true });
    expect(Object.keys(s().lineTries)).toEqual(["x".repeat(32)]);
    expect(s().lineTries["x".repeat(32)].status).toBe("running");
  });
});

describe("askLineAgent", () => {
  it("paints the cause in progress and sends the ask", async () => {
    void s().askLineAgent("ask1", PROJECT, { subject: "line:station:investigate", title: "Stop guessing", detail_md: "words" }).catch(() => {});
    expect(s().tasks[taskStubId("ask1")]).toMatchObject({ status: "in_progress", category: "line", project_id: PROJECT, title: "Stop guessing" });
    await settle();
    expect(calls[0]).toEqual(["askLineAgent", ["ask1", PROJECT, { subject: "line:station:investigate", title: "Stop guessing", detail_md: "words" }]]);
  });
});
