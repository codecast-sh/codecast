// ct-85482 (eg-2124/eg-2242): the Ship chip's feeder sent an optimistic
// session stub ("stgnjnsa2volusv43jdxs") to sessionFlowRuns.forConversation,
// whose v.id("conversations") validator threw ArgumentValidationError on /inbox.
import { describe, expect, mock, test } from "bun:test";
import * as real from "../useSyncCollection";

const calls: unknown[] = [];
mock.module("../useSyncCollection", () => ({
  ...real,
  useSyncCollection: (_key: string, _query: unknown, args: unknown) => {
    calls.push(args);
    return { ready: false };
  },
}));

const { useSyncSessionFlowRuns } = await import("../useSyncWorkflows");

const argsFor = (id: string | null | undefined) => {
  calls.length = 0;
  useSyncSessionFlowRuns(id);
  return calls[0];
};

describe("useSyncSessionFlowRuns", () => {
  test("a Convex id becomes the query args", () => {
    expect(argsFor("jx7edd00y85v1rgj5tda5s9cm98ewywv")).toEqual({ conversation_id: "jx7edd00y85v1rgj5tda5s9cm98ewywv" });
  });

  test.each([
    ["the optimistic stub from eg-2124", "stgnjnsa2volusv43jdxs"],
    ["the optimistic stub from eg-2242", "8dag8kakr4ribavdsgnfen"],
    ["a daemon session uuid", "ede6592d-acce-4fd2-8b03-1b704450825b"],
    ["an empty id", ""],
    ["no id", undefined],
  ])("%s skips the query", (_label, id) => {
    expect(argsFor(id)).toBe("skip");
  });
});
