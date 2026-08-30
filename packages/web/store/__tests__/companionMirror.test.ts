import { describe, expect, it } from "bun:test";
import {
  companionMirrorStep,
  companionRenderable,
  createWorkspace,
  hidePane,
  setPresentation,
  showPane,
  type Pane,
  type WorkspaceState,
} from "../workspace";

// The "empty column" bug: the secondary slot names a conversation whose
// session row is gone (killed, pruned at boot, restored from a stale tab
// stamp). The panel used to expand on the slot ref alone while StageCompanion
// rendered null into it — a blank column up to 65% of the stage. These pin the
// pure rule that now gates the panel and cleans the slot.

const convo = (ref: string): Pane => ({ kind: "conversation", ref });

const has =
  (...ids: string[]) =>
  (id: string) =>
    ids.includes(id);

function withCompanion(ref: string, presentation: "split" | "overlay" = "split"): WorkspaceState {
  return showPane(createWorkspace(), "secondary", convo(ref), { presentation });
}

describe("companionRenderable", () => {
  it("is true only when the slot ref resolves to a real row", () => {
    expect(companionRenderable(withCompanion("a"), has("a"))).toBe(true);
    expect(companionRenderable(withCompanion("ghost"), has("a"))).toBe(false);
    expect(companionRenderable(createWorkspace(), has("a"))).toBe(false);
  });
});

describe("companionMirrorStep on a working surface", () => {
  it("opens the attended conversation when its row exists", () => {
    const step = companionMirrorStep(createWorkspace(), "a", true, has("a"));
    expect(step).toEqual({ op: "show", pane: convo("a") });
  });

  it("refuses to open a companion for an attended id the store cannot resolve", () => {
    const step = companionMirrorStep(createWorkspace(), "ghost", true, has("a"));
    expect(step.op).toBe("none");
  });

  it("closes a companion whose row vanished, even when it is the attended one", () => {
    const ws = withCompanion("ghost");
    expect(companionMirrorStep(ws, "ghost", true, has()).op).toBe("hide");
  });

  it("follows the attended conversation when it changes", () => {
    const ws = withCompanion("a");
    const step = companionMirrorStep(ws, "b", true, has("a", "b"));
    expect(step).toEqual({ op: "show", pane: convo("b") });
  });

  it("leaves a live matching companion alone", () => {
    const ws = withCompanion("a");
    expect(companionMirrorStep(ws, "a", true, has("a")).op).toBe("none");
  });

  it("respects a hand-close of the same pane", () => {
    const ws = hidePane(withCompanion("a"), "secondary", { remember: true });
    expect(companionMirrorStep(ws, "a", true, has("a")).op).toBe("none");
  });
});

describe("companionMirrorStep off working surfaces", () => {
  it("closes a split companion", () => {
    expect(companionMirrorStep(withCompanion("a"), "a", false, has("a")).op).toBe("hide");
  });

  it("closes a ghost split companion too", () => {
    expect(companionMirrorStep(withCompanion("ghost"), null, false, has()).op).toBe("hide");
  });

  it("never touches an overlay (the fleet board's drill-in)", () => {
    const ws = withCompanion("a", "overlay");
    expect(companionMirrorStep(ws, "a", false, has("a")).op).toBe("none");
  });

  it("does nothing with an empty slot", () => {
    let ws = createWorkspace();
    ws = setPresentation(ws, "secondary", "split");
    expect(companionMirrorStep(ws, "a", false, has("a")).op).toBe("none");
  });
});
