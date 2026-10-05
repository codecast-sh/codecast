import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { undoAsOne } from "../undoActions";
import "../undoStack";

// Skip on a proposal card decides every waiting change in one press. The
// org specs are external (each call is recorded), so the press must be one
// group or the timeline shows one unnamed row per change.
const s = () => useInboxStore.getState() as any;
const owner = {};

afterAll(() => s()._clearDispatch?.(owner));
beforeEach(() => {
  _resetUndoStacks();
  s()._setDispatch(async () => null, { owner });
});

describe("skipping an org proposal", () => {
  it("ungrouped, each change is its own row (the defect's shape)", () => {
    for (const id of ["ch-1", "ch-2", "ch-3"]) s().decideOrgProposalChange(id, "skip");
    expect(getUndoHistory().items.map((i: any) => i.label)).toEqual(["Skipped an org change", "Skipped an org change", "Skipped an org change"]);
  });

  it("as the card runs it, one press is one row named for the proposal", () => {
    undoAsOne("Skipped an org proposal", () => {
      for (const id of ["ch-1", "ch-2", "ch-3"]) s().decideOrgProposalChange(id, "skip");
    });
    const items = getUndoHistory().items;
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Skipped an org proposal");
  });
});
