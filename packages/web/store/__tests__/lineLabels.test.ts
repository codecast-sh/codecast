// labelDecision (line-workspace.md LW4): a label paints in the same tick,
// rides the dispatch of the same name, survives a stale push, and the
// server row supersedes the stub by its natural key.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { lineLabelStubId } from "../lineSlice";
import { lineLabelKey } from "../../lib/line/lineLabels";

const s = () => useInboxStore.getState() as any;
const ME = "u".repeat(32);
const RUN = "r".repeat(32);
const WS = "team:" + "t".repeat(32);
const KEY = lineLabelKey(RUN, "dissolve", ME);

let calls: Array<[string, unknown[]]> = [];
const owner = {};
beforeAll(() => s()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  calls = [];
  useInboxStore.setState({ lineLabels: {}, pending: {}, currentUser: { _id: ME }, workflowRuns: { [RUN]: { _id: RUN, workspace: WS, team_id: "t".repeat(32) } } } as any);
});
const settle = async () => { for (let i = 0; i < 100 && calls.length === 0; i++) await Bun.sleep(2); };
const server = (over: Record<string, unknown> = {}) => ({ _id: "l".repeat(32), key: KEY, workspace: WS, run_id: RUN, node_id: "dissolve", verdict: "wrong", note: "Missed it", by: ME, at: 10, ...over });

describe("labelDecision", () => {
  it("paints a stub in the run's workspace at once, sends the label, and the server row supersedes it", async () => {
    s().labelDecision(RUN, "dissolve", "wrong", "  Missed it ");
    const stub = s().lineLabels[lineLabelStubId(KEY)];
    expect(stub).toMatchObject({ key: KEY, workspace: WS, verdict: "wrong", note: "Missed it", by: ME });
    await settle();
    expect(calls[0]).toEqual(["labelDecision", [RUN, "dissolve", "wrong", "  Missed it "]]);
    s().syncTable("lineLabels", [server()]);
    expect(Object.keys(s().lineLabels)).toEqual(["l".repeat(32)]);
  });

  it("changing a verdict holds against a stale push until the echo", () => {
    s().syncTable("lineLabels", [server()]);
    s().labelDecision(RUN, "dissolve", "right", null);
    expect(s().lineLabels["l".repeat(32)].verdict).toBe("right");
    s().syncTable("lineLabels", [server()]);
    expect(s().lineLabels["l".repeat(32)].verdict).toBe("right");
  });

  it("a null verdict takes the label back, and a push from before the delete does not return it", () => {
    s().syncTable("lineLabels", [server()]);
    s().labelDecision(RUN, "dissolve", null);
    expect(s().lineLabels["l".repeat(32)]).toBeUndefined();
    s().syncTable("lineLabels", [server()]);
    expect(s().lineLabels["l".repeat(32)]).toBeUndefined();
  });
});
