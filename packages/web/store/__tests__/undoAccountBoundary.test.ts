import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, performUndo } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { onAuthPrincipalChange } from "../principalBoundary";
import * as undoTimeline from "../../lib/undoTimelineOpen";
// The app installs its notifier and reset listener from here.
import "../undoStack";

// The undo history, its send order, the timeline card and its toasts belong
// to the account that made them. An in-place account switch must leave none
// of it, or a ⌘Z replays the old account's rows into the new one's store and
// sends the inverse as the new account.
const DOC = "d".repeat(32);
const s = () => useInboxStore.getState() as any;
const owner = {};

afterAll(() => s()._clearDispatch?.(owner));
beforeEach(() => {
  _resetUndoStacks();
  useInboxStore.setState({
    docs: { [DOC]: { _id: DOC, title: "Account A secret plan" } },
    docDetails: { [DOC]: { _id: DOC, title: "Account A secret plan", content: "# A's private body" } },
    pending: {},
  } as any);
});

describe("an account switch", () => {
  it("leaves no undo history, no open card, and nothing for a ⌘Z to replay", () => {
    const calls: string[] = [];
    s()._setDispatch(async (a: string) => {
      calls.push(a);
      return null;
    }, { owner });
    s().archiveDoc(DOC);
    expect(getUndoHistory().items).toHaveLength(1);
    undoTimeline.open("interactive");

    // No previous principal: the disk purge needs a browser; the in-memory reset is the same.
    onAuthPrincipalChange({ previous: null, next: null } as any);
    s()._setDispatch(async (a: string) => {
      calls.push(`B:${a}`);
      return null;
    }, { owner });

    expect(getUndoHistory().items).toEqual([]);
    expect(undoTimeline.isOpen()).toBe(false);
    expect(performUndo()).toBe(false);
    expect(s().docs?.[DOC]).toBeUndefined();
    expect(calls.filter((c) => c.startsWith("B:"))).toEqual([]);
  });
});
