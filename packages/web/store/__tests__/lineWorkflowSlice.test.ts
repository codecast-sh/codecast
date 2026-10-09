import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { isViewersWorkflow, lineWorkflowStubId } from "../lineWorkflowSlice";
import { SHIPPED_LINE } from "../../lib/line/shippedLine.generated";
import { editStation, forkShippedLine, stationDiffs } from "../../lib/line/lineStations";

const s = () => useInboxStore.getState() as any;
const SERVER = "w".repeat(32);
const project = { _id: "j".repeat(32), short_id: "pj-1", title: "Codecast" };

let calls: Array<[string, unknown[]]> = [];
const owner = {};
beforeAll(() => s()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => { calls = []; useInboxStore.setState({ workflows: {}, pending: {} } as any); });

const settle = async () => { for (let i = 0; i < 100 && calls.length === 0; i++) await Bun.sleep(2); };

describe("saveLineWorkflow", () => {
  it("a fork paints a stub at once, sends the whole workflow, and the server row supersedes it by slug", async () => {
    const fork = forkShippedLine(SHIPPED_LINE, project);
    s().saveLineWorkflow(fork);
    const stub = s().workflows[lineWorkflowStubId("line-pj-1")];
    expect(stub?.slug).toBe("line-pj-1");
    expect(stub.nodes.length).toBe(SHIPPED_LINE.nodes.length);
    await settle();
    expect(calls[0]?.[0]).toBe("saveLineWorkflow");
    expect((calls[0]?.[1] as any[])[0].slug).toBe("line-pj-1");

    s().syncTable("workflows", [{ _id: SERVER, ...fork, user_id: "u", created_at: 1, updated_at: 1 }], { isDelta: true });
    expect(Object.keys(s().workflows)).toEqual([SERVER]);
  });

  it("an edit paints the station in the same tick and survives a stale push until the echo", async () => {
    const fork = forkShippedLine(SHIPPED_LINE, project);
    const server = { _id: SERVER, ...fork, user_id: "u", created_at: 1, updated_at: 1 };
    s().syncTable("workflows", [server], { isDelta: true });
    const edited = { ...fork, nodes: editStation(fork.nodes, "ground", { prompt: "Mine." }) };
    s().saveLineWorkflow(edited);
    expect(stationDiffs(s().workflows[SERVER].nodes, SHIPPED_LINE)).toEqual({ ground: ["prompt"] });
    // A push from before the server saw the edit does not take it back.
    s().syncTable("workflows", [server], { isDelta: true });
    expect(stationDiffs(s().workflows[SERVER].nodes, SHIPPED_LINE)).toEqual({ ground: ["prompt"] });
    // The echo settles it.
    s().syncTable("workflows", [{ ...server, nodes: edited.nodes, updated_at: 2 }], { isDelta: true });
    expect(stationDiffs(s().workflows[SERVER].nodes, SHIPPED_LINE)).toEqual({ ground: ["prompt"] });
    expect(Object.keys(s().pending).filter((k) => k.startsWith("workflows:"))).toEqual([]);
  });

  it("the fork goes as a create, and paints nothing over a row this window already holds", async () => {
    const fork = forkShippedLine(SHIPPED_LINE, project);
    const edited = { ...fork, nodes: editStation(fork.nodes, "ground", { prompt: "Mine." }) };
    s().syncTable("workflows", [{ _id: SERVER, ...edited, user_id: "u", created_at: 1, updated_at: 1 }], { isDelta: true });
    s().saveLineWorkflow(fork, { create: true });
    expect(stationDiffs(s().workflows[SERVER].nodes, SHIPPED_LINE)).toEqual({ ground: ["prompt"] });
    expect(s().workflows[lineWorkflowStubId("line-pj-1")]).toBeUndefined();
    await settle();
    expect(calls[0]?.[1]).toEqual([fork, { create: true }]);
  });

  it("stop customizing drops the fork and keeps a stale push from bringing it back", async () => {
    const fork = forkShippedLine(SHIPPED_LINE, project);
    const server = { _id: SERVER, ...fork, user_id: "u", created_at: 1, updated_at: 1 };
    s().syncTable("workflows", [server], { isDelta: true });
    s().removeLineWorkflow("line-pj-1");
    expect(s().workflows[SERVER]).toBeUndefined();
    s().syncTable("workflows", [server], { isDelta: true });
    expect(s().workflows[SERVER]).toBeUndefined();
    await settle();
    expect(calls[0]).toEqual(["removeLineWorkflow", ["line-pj-1"]]);
  });
});

// workflow_runs.graphOfRun feeds the graph a teammate's run ran into the same
// collection, so a row of the same slug may be someone else's (ct-58329).
describe("a teammate's workflow row in the collection", () => {
  const ME = "users_me";
  const FOREIGN = "f".repeat(32);
  const theirs = (fork: any) => ({ _id: FOREIGN, ...fork, user_id: "users_teammate", created_at: 1, updated_at: 1 });
  beforeEach(() => useInboxStore.setState({ currentUser: { _id: ME } } as any));
  afterAll(() => useInboxStore.setState({ currentUser: null } as any));

  it("an edit never lands on it: the viewer's own fork is created", async () => {
    const fork = forkShippedLine(SHIPPED_LINE, project);
    s().syncTable("workflows", [theirs(fork)], { isDelta: true });
    s().saveLineWorkflow({ ...fork, nodes: editStation(fork.nodes, "ground", { prompt: "Mine." }) });
    expect(stationDiffs(s().workflows[FOREIGN].nodes, SHIPPED_LINE)).toEqual({});
    expect(s().workflows[lineWorkflowStubId("line-pj-1")]?.user_id).toBe(ME);
  });

  it("stop customizing never removes it", async () => {
    const fork = forkShippedLine(SHIPPED_LINE, project);
    s().syncTable("workflows", [theirs(fork)], { isDelta: true });
    s().removeLineWorkflow("line-pj-1");
    expect(s().workflows[FOREIGN]).toBeDefined();
  });

  it("is not the viewer's", () => {
    expect(isViewersWorkflow({ user_id: "users_teammate" }, ME)).toBe(false);
    expect(isViewersWorkflow({ user_id: ME }, ME)).toBe(true);
    expect(isViewersWorkflow({ user_id: "" }, ME)).toBe(true);
    expect(isViewersWorkflow({ user_id: "users_teammate" }, null)).toBe(true);
  });
});
