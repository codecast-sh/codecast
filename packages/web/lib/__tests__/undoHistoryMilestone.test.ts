import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import * as undoTimeline from "../undoTimelineOpen";
import { fireUndoHistoryMilestone } from "../undoHistory";

// The milestone tip points at the undo timeline. While the card is showing,
// or the same press is opening it (the held peek), it stays quiet: it would
// sit over the rows the card narrates.
const seen = () => ((useInboxStore.getState().clientState as any).tips?.seen ?? []) as string[];

describe("the undo history milestone", () => {
  beforeEach(() => {
    undoTimeline.close();
    useInboxStore.setState({ clientStateInitialized: true, clientState: { tips: { seen: [] } } } as any);
  });

  it("does not fire while the card is open", () => {
    undoTimeline.open("peek");
    fireUndoHistoryMilestone();
    expect(seen()).not.toContain("m-undo-history");
  });

  it("does not fire on the press that opens the peek", () => {
    fireUndoHistoryMilestone(true);
    expect(seen()).not.toContain("m-undo-history");
  });

  it("fires when no card is showing", () => {
    fireUndoHistoryMilestone();
    expect(seen()).toContain("m-undo-history");
  });
});
