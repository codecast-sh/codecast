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
