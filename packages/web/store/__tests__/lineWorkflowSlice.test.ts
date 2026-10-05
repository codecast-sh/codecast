import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { lineWorkflowStubId } from "../lineWorkflowSlice";
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
});
