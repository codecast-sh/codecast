import { describe, expect, it } from "bun:test";
import { STALE_PROMPT_AFTER_MS } from "./kind";
import { createUpdatePrompt, updatePromptKeys, type ServedVersion } from "./prompt";

function harness(served: ServedVersion | null, baked = 3) {
  const store = new Map<string, string>();
  const shows: { kind: string; served: ServedVersion; close: () => void }[] = [];
  const ticks: (() => void)[] = [];
  let clock = 1_000;
  let fetches = 0;
  const prompt = createUpdatePrompt({
    appKey: "app",
    bakedGeneration: baked,
    show: (kind, s, close) => shows.push({ kind, served: s, close }),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    fetchServed: async () => { fetches++; return served; },
    now: () => clock,
    every: (fn) => ticks.push(fn),
  });
  return {
    prompt, store, shows, ticks,
    advance: (ms: number) => { clock += ms; },
    fetches: () => fetches,
  };
}

describe("createUpdatePrompt", () => {
  it("asks nothing until an update is waiting", async () => {
    const h = harness({ promptGeneration: 4 });
    await h.prompt.settled();
    expect(h.fetches()).toBe(0);
    expect(h.shows).toHaveLength(0);
  });

  it("stays silent for a routine deploy", async () => {
    const h = harness({ promptGeneration: 3 });
    h.prompt.noteUpdateWaiting();
    await h.prompt.settled();
    expect(h.shows).toHaveLength(0);
  });

  it("shows an announced release once, and Later dismisses that generation in storage", async () => {
    const h = harness({ promptGeneration: 4, promptMessage: "Fixes the crash." });
    h.prompt.noteUpdateWaiting();
    await h.prompt.settled();
    expect(h.shows.map((s) => s.kind)).toEqual(["release"]);
    expect(h.shows[0]!.served.promptMessage).toBe("Fixes the crash.");

    // A second deploy while the card is up does not stack another.
    h.prompt.noteUpdateWaiting();
    await h.prompt.settled();
    expect(h.shows).toHaveLength(1);

    h.shows[0]!.close();
    h.shows[0]!.close();
    expect(h.store.get(updatePromptKeys("app").dismissed)).toBe("4");
    h.prompt.noteUpdateWaiting();
    await h.prompt.settled();
    expect(h.shows).toHaveLength(1);
  });

  it("prompts a window left a day behind on the hourly recheck, and Later snoozes a day", async () => {
    const h = harness({ promptGeneration: 3 });
    h.prompt.noteUpdateWaiting();
    h.prompt.noteUpdateWaiting();
    expect(h.ticks).toHaveLength(1);

    h.advance(STALE_PROMPT_AFTER_MS);
    h.ticks[0]!();
    await h.prompt.settled();
    expect(h.shows.map((s) => s.kind)).toEqual(["stale"]);

    h.shows[0]!.close();
    expect(Number(h.store.get(updatePromptKeys("app").snoozed))).toBe(1_000 + 2 * STALE_PROMPT_AFTER_MS);
    h.ticks[0]!();
    await h.prompt.settled();
    expect(h.shows).toHaveLength(1);
  });

  it("namespaces storage by app, keeping codecast's existing keys", () => {
    expect(updatePromptKeys("codecast")).toEqual({
      dismissed: "codecast:update-prompt:dismissed-generation",
      snoozed: "codecast:update-prompt:stale-snoozed-until",
    });
  });
});
