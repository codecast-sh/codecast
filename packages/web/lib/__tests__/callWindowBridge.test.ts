import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canResizeCallWindow,
  getCallWindowSize,
  setCallWindowContentSize,
  setCallWindowDragging,
  setCallWindowInteractive,
  setCallWindowSize,
  type CallWindowSize,
} from "../desktop";
import { SMALL_CALL_WINDOW_SIZES, faceTierForSize, facesModeForSize } from "../desktop";

// The founder's desktop is on a build that has the call panel and none of the
// sizes. Web ships on every push and the shell ships on its own clock, so a
// renderer asking an older shell for something it has never heard of is the
// ordinary case, not the edge one — and every verb here has to answer that
// build honestly rather than throw inside a window holding a live call.

const original = (globalThis as any).window;

function shell(bridge: Record<string, unknown> | null) {
  (globalThis as any).window = bridge === null ? {} : { __CODECAST_ELECTRON__: bridge };
}

afterEach(() => {
  (globalThis as any).window = original;
});

describe("canResizeCallWindow", () => {
  it("is false in a browser, where there is no shell at all", () => {
    shell(null);
    expect(canResizeCallWindow()).toBe(false);
  });

  it("is false on a desktop build that predates the sizes", () => {
    // 1.1.96: the panel exists, the sizes do not. The surface must be able to
    // tell this apart from "not on the desktop", because here the answer is
    // "your app needs an update" rather than "this control does not apply".
    shell({ isCallPanelWindow: true, openCallPanel: () => {} });
    expect(canResizeCallWindow()).toBe(false);
  });

  it("is false in a window that is not the call window", () => {
    // The main window has the same bridge object. Only the window the shell
    // opened as the call may reshape itself.
    shell({ isCallPanelWindow: false, setCallWindowSize: async () => "circles" });
    expect(canResizeCallWindow()).toBe(false);
  });

  it("is true only in the call window of a build that has the sizes", () => {
    shell({ isCallPanelWindow: true, setCallWindowSize: async () => "circles" });
    expect(canResizeCallWindow()).toBe(true);
  });
});

describe("setCallWindowSize", () => {
  it("answers null on a build without the sizes, instead of pretending", () => {
    // Null is what the panel turns into "the desktop app needs an update". A
    // silent no-op here would read as the feature being broken.
    shell({ isCallPanelWindow: true });
    return setCallWindowSize("circles").then((landed) => expect(landed).toBeNull());
  });

  it("reports the size the SHELL landed on, not the one asked for", () => {
    // The shell is what the size actually is — it moves the window, floats it
    // and lets the mouse through — so it has the last word, including when it
    // refuses an unknown name and stays on the stage.
    const asked: CallWindowSize[] = [];
    shell({
      isCallPanelWindow: true,
      setCallWindowSize: async (size: CallWindowSize) => {
        asked.push(size);
        return "panel";
      },
    });
    return setCallWindowSize("speaker").then((landed) => {
      expect(asked).toEqual(["speaker"]);
      expect(landed).toBe("panel");
    });
  });

  it("reads back the size the shell has the window in", () => {
    shell({ isCallPanelWindow: true, getCallWindowSize: async () => "speaker" });
    return getCallWindowSize().then((size) => expect(size).toBe("speaker"));
  });

  it("reads back null where there is no shell to ask", () => {
    shell(null);
    return getCallWindowSize().then((size) => expect(size).toBeNull());
  });
});

describe("the three verbs a see-through size needs", () => {
  it("are silent on a build that has none of them", () => {
    // These fire from a mouse-move handler and a resize effect, dozens of times
    // a second. On an older shell they must do nothing at all — a throw here
    // would take down the window with the person's microphone in it.
    shell({ isCallPanelWindow: true });
    expect(() => {
      setCallWindowInteractive(true);
      setCallWindowContentSize({ width: 112, height: 112 });
      setCallWindowDragging(true);
    }).not.toThrow();
  });

  it("reach the shell when it has them", () => {
    const seen: unknown[] = [];
    shell({
      isCallPanelWindow: true,
      setCallWindowInteractive: (on: boolean) => seen.push(["interactive", on]),
      setCallWindowContentSize: (s: unknown) => seen.push(["size", s]),
      setCallWindowDragging: (on: boolean) => seen.push(["drag", on]),
    });
    setCallWindowInteractive(true);
    setCallWindowContentSize({ width: 112, height: 112 });
    setCallWindowDragging(false);
    expect(seen).toEqual([
      ["interactive", true],
      ["size", { width: 112, height: 112 }],
      ["drag", false],
    ]);
  });
});

describe("what each size shows", () => {
  it("keeps how MANY circles apart from how BIG they are", () => {
    // Mode and tier are separate questions, and `tiny` is the size that answers
    // them differently: one face, at the smallest tier. Every other size takes
    // its mode's own tier.
    expect(facesModeForSize("circles")).toBe("everyone");
    expect(facesModeForSize("speaker")).toBe("speaker");
    expect(facesModeForSize("tiny")).toBe("speaker");
    expect(faceTierForSize("circles")).toBe("row");
    expect(faceTierForSize("speaker")).toBe("speaker");
    expect(faceTierForSize("tiny")).toBe("mini");
  });
});

describe("the stage's size controls", () => {
  it("offers exactly the sizes that are not the stage", () => {
    // A size the shell knows about with no button is a shape nobody can reach.
    // The stage maps over this list and looks each icon and hint up by key, so
    // a missing button is a type error; this pins the list itself.
    expect([...SMALL_CALL_WINDOW_SIZES]).toEqual(["circles", "speaker", "tiny"]);
    expect(SMALL_CALL_WINDOW_SIZES.some((s) => (s as string) === "panel")).toBe(false);
  });
});

describe("one place decides what an older build is told", () => {
  it("keeps every size change going through the call window's own handler", () => {
    // `CallPanel.applySize` is the single caller of the bridge, because it is
    // where the null answer becomes a message the person can read. A surface
    // calling the bridge directly would change the window's size on new builds
    // and do nothing at all on the founder's.
    const web = join(import.meta.dir, "..", "..");
    for (const file of ["components/calls/CallStage.tsx", "components/calls/CallFaces.tsx"]) {
      const src = readFileSync(join(web, file), "utf8");
      expect(src.includes("setCallWindowSize")).toBe(false);
    }
    const panel = readFileSync(join(web, "components/calls/CallPanel.tsx"), "utf8");
    expect(panel.includes("setCallWindowSize")).toBe(true);
  });
});
