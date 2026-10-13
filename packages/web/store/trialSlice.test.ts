import { afterEach, describe, expect, test } from "bun:test";
import { createTrialSlice } from "./trialSlice";
import { AGENT_TAB_KEY } from "../lib/desktopHandoff";

const store = new Map<string, string>();
(globalThis as any).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

function draft() {
  return {
    currentUser: { _id: "u1" },
    trialRuns: {},
    trialCards: { c1: { status: "waiting", options: [{ key: "S", label: "Ship" }, { key: "D", label: "Not now" }] } as any },
  };
}

describe("trialReask", () => {
  test("the problem's waiting cards say they were asked again; an answered one and another problem's stay as they are", () => {
    const d = { currentUser: { _id: "u1" }, trialRuns: {}, trialCards: {
      a: { task_id: "t1", status: "waiting" }, b: { task_id: "t1", status: "answered" }, c: { task_id: "t2", status: "waiting" },
    } as Record<string, any> };
    (createTrialSlice().trialReask as any).call(d, "t1");
    expect(d.trialCards.a.reask_at).toBeGreaterThan(0);
    expect(d.trialCards.b.reask_at).toBeUndefined();
    expect(d.trialCards.c.reask_at).toBeUndefined();
  });
});

describe("trialAnswer", () => {
  afterEach(() => store.clear());

  test("a person's tab records the person's answer", () => {
    const d = draft();
    const out = (createTrialSlice().trialAnswer as any).call(d, "c1", "s");
    expect(out).toBeUndefined();
    expect(d.trialCards.c1.answer).toMatchObject({ key: "S", stand_in: false });
  });

  test("a tab a cast browser session drives answers as a stand-in, and tells the server so", () => {
    store.set(AGENT_TAB_KEY, "1");
    const d = draft();
    const out = (createTrialSlice().trialAnswer as any).call(d, "c1", "D", "test");
    expect(out).toEqual({ agent: true });
    expect(d.trialCards.c1.answer).toMatchObject({ key: "D", note: "test", stand_in: true });
  });
});
