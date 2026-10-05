import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { _resetUndoStacks, getUndoHistory } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { performUndo } from "../undoStack";
import { animatedHideSessions, animatedSetSessionRest } from "../undoActions";

// The animated session gestures write once the cards' collapse ends, but the
// gesture is the user's newest the moment it starts. ⌘Z during the collapse
// takes that gesture back, never an older entry that the gesture would then
// land over (dropping its redo).
const PINNED = "p".repeat(32);
const MOVED = "m".repeat(32);

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "MutationObserver", "Element", "HTMLElement", "Event"] as const) {
    (globalThis as any)[key] = (dom.window as any)[key];
  }
});

function seed() {
  const row = (id: string, title: string) => ({ _id: id, title, updated_at: 1 });
  useInboxStore.setState({
    pending: {},
    sessions: { [PINNED]: row(PINNED, "Ta"), [MOVED]: row(MOVED, "Tb") },
    conversations: { [PINNED]: row(PINNED, "Ta"), [MOVED]: row(MOVED, "Tb") },
  } as any);
}

function mountCard(id: string) {
  const wrapper = document.createElement("div");
  const card = document.createElement("div");
  card.dataset.sessionId = id;
  wrapper.appendChild(card);
  document.body.appendChild(wrapper);
  return wrapper;
}

const row = (id: string) => useInboxStore.getState().sessions[id] as any;
const statuses = () => getUndoHistory().items.map((i) => i.status);

const GESTURES: Array<[string, () => Promise<unknown>, () => boolean]> = [
  ["stash", () => animatedHideSessions([MOVED], "stash"), () => !!row(MOVED)?.inbox_stashed_at],
  ["stash and hide", () => animatedHideSessions([MOVED], "stash", { hidden: true }), () => !!row(MOVED)?.inbox_stashed_at],
  ["kill", () => animatedHideSessions([MOVED], "kill"), () => !!row(MOVED)?.inbox_killed_at],
  ["file as rest", () => animatedSetSessionRest(MOVED, "done"), () => row(MOVED)?.user_rest === "done"],
];

describe("an undo during a gesture's exit animation takes back that gesture", () => {
  beforeEach(() => {
    _resetUndoStacks();
    document.body.innerHTML = "";
    seed();
  });

  for (const [name, start, landed] of GESTURES) {
    test(name, async () => {
      useInboxStore.getState().pinSession(PINNED);
      const wrapper = mountCard(MOVED);
      const done = start();
      expect(wrapper.classList.contains("session-dismissing")).toBe(true);
      expect(performUndo()).toBe(true);
      // The gesture landed and was taken back; the older pin stands.
      expect(landed()).toBe(false);
      expect(row(PINNED)?.is_pinned).toBe(true);
      expect(statuses()).toEqual(["undone", "done"]);
      // The card the collapse was cut short on shows whole again.
      expect(wrapper.classList.contains("session-dismissing")).toBe(false);
      wrapper.dispatchEvent(new Event("animationend"));
      await done;
      expect(landed()).toBe(false);
      expect(statuses()).toEqual(["undone", "done"]);
    });
  }
});

// The class: a gesture whose store write runs after a wait. The row exit is
// the one such wait, so it lives in one place, and that place registers the
// write with the undo stack before it waits (deferUndoGesture).
describe("a gesture's write after its exit animation is registered before the wait", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  test("only store/undoActions.ts collapses a row out", () => {
    const out = Bun.spawnSync(["git", "grep", "-lE", "session-dismissing", "--", "app", "components", "hooks", "store", "lib"], { cwd: ROOT });
    const files = out.stdout.toString().split("\n").filter((f) => f && !/(__tests__|\.test\.tsx?$|\.css$)/.test(f));
    expect(files).toEqual(["store/undoActions.ts"]);
  }, 60_000);

  test("every exit is started by afterSessionExits, which defers its write", () => {
    const src = readFileSync(join(ROOT, "store", "undoActions.ts"), "utf8");
    const helper = src.slice(src.indexOf("function afterSessionExits"), src.indexOf("\n}\n", src.indexOf("function afterSessionExits")));
    expect(helper).toContain("deferUndoGesture(");
    const starts = [...src.matchAll(/startSessionExit\(/g)].length;
    // Its definition, and its one call inside afterSessionExits.
    expect(starts).toBe(2);
    expect(helper).toContain("startSessionExit(");
    expect(src).not.toMatch(/await [^;]*(exitFinished|startSessionExit)/);
  });
});
