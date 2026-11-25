import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useCodeStore } from "../../../store/codeStore";
import { workspaceActions as A } from "./controller";
import { registerGroupSwitcher } from "./groupRegistry";
import { emptyWorkspace, keepOpen, openTab, type Workspace } from "./model";

const V = "ctl-vault";
const frames: Array<() => void> = [];
const realRaf = globalThis.requestAnimationFrame;
const ws = () => useCodeStore.getState().workspaces[V];
/** Run the next frame's callbacks and the task after them. */
async function paint() {
  for (const cb of frames.splice(0)) cb();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  globalThis.requestAnimationFrame = ((cb: () => void) => frames.push(cb)) as unknown as typeof requestAnimationFrame;
  let w: Workspace = emptyWorkspace();
  for (const p of ["a.ts", "b.ts", "c.ts"]) w = keepOpen(openTab(w, p), "g1", p);
  useCodeStore.setState((s) => ({ workspaces: { ...s.workspaces, [V]: w } }));
});

afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
});

describe("tab switches", () => {
  test("an open buffer is shown inside the verb, and the store follows after the paint", async () => {
    const shown: string[] = [];
    const off = registerGroupSwitcher(V, "g1", (p) => (shown.push(p), true));
    A.activate(V, "g1", "a.ts");
    expect(shown).toEqual(["a.ts"]);
    expect(ws().groups[0].active).toBe("c.ts");
    // A second switch before the paint builds on the first.
    A.activate(V, "g1", "b.ts");
    expect(shown).toEqual(["a.ts", "b.ts"]);
    await paint();
    expect(ws().groups[0].active).toBe("b.ts");
    off();
  });

  test("a buffer that is not open yet goes through the store at once", () => {
    const off = registerGroupSwitcher(V, "g1", () => false);
    A.activate(V, "g1", "a.ts");
    expect(ws().groups[0].active).toBe("a.ts");
    off();
  });

  test("any other verb commits the waiting switch first", async () => {
    const off = registerGroupSwitcher(V, "g1", () => true);
    A.activate(V, "g1", "a.ts");
    A.close(V, "g1", "b.ts");
    expect(ws().groups[0].tabs.map((t) => t.path)).toEqual(["a.ts", "c.ts"]);
    expect(ws().groups[0].active).toBe("a.ts");
    await paint();
    expect(ws().groups[0].active).toBe("a.ts");
    off();
  });

  test("a write from elsewhere before the paint is kept, and the switch lands on top", async () => {
    const off = registerGroupSwitcher(V, "g1", () => true);
    A.activate(V, "g1", "a.ts");
    useCodeStore.getState().updateWorkspace(V, (w) => keepOpen(openTab(w, "d.ts"), "g1", "d.ts"));
    await paint();
    expect(ws().groups[0].tabs.map((t) => t.path)).toContain("d.ts");
    expect(ws().groups[0].active).toBe("a.ts");
    off();
  });

  test("a hidden document, which runs no frames, still gets the store write", async () => {
    const realDoc = (globalThis as any).document;
    const listeners: Array<() => void> = [];
    (globalThis as any).document = { hidden: true, addEventListener: (_: string, cb: () => void) => listeners.push(cb), removeEventListener: () => {} };
    const off = registerGroupSwitcher(V, "g1", () => true);
    try {
      A.activate(V, "g1", "a.ts");
      await new Promise((r) => setTimeout(r, 0));
      expect(frames.length).toBe(0);
      expect(ws().groups[0].active).toBe("a.ts");
      // Visible when the switch happens, hidden before the frame: the
      // visibility change flushes it.
      (globalThis as any).document.hidden = false;
      A.activate(V, "g1", "b.ts");
      expect(ws().groups[0].active).toBe("a.ts");
      for (const cb of listeners.splice(0)) cb();
      expect(ws().groups[0].active).toBe("b.ts");
    } finally {
      off();
      frames.length = 0;
      (globalThis as any).document = realDoc;
    }
  });
});
