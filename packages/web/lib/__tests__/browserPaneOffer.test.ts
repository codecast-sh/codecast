import { describe, expect, test } from "bun:test";
import { PANE_OFFER_TTL_MS } from "@codecast/shared/contracts";
import { paneOfferDecision, paneOfferLabel, paneOfferHint } from "../browserPaneOffer";

const NOW = 1_700_000_000_000;
const fresh = { url: "http://localhost:3000/", offered_at: NOW - 1000 };

const decide = (over: Partial<Parameters<typeof paneOfferDecision>[0]> = {}) =>
  paneOfferDecision({ offer: fresh, now: NOW, attended: true, autoOpen: false, hasRoom: true, ...over });

describe("paneOfferDecision", () => {
  test("a fresh unopened offer shows, and does not open itself", () => {
    expect(decide()).toEqual({ show: true, autoOpen: false });
  });

  test("an offer the reader already acted on is gone", () => {
    expect(decide({ offer: { ...fresh, opened_at: NOW } }).show).toBe(false);
    expect(decide({ offer: null }).show).toBe(false);
  });

  test("a day-old offer goes quiet", () => {
    expect(decide({ offer: { ...fresh, offered_at: NOW - PANE_OFFER_TTL_MS - 1 } }).show).toBe(false);
    expect(decide({ offer: { ...fresh, offered_at: NOW - PANE_OFFER_TTL_MS + 1 } }).show).toBe(true);
  });

  test("auto-open needs the preference, the reader's attention, and room", () => {
    expect(decide({ autoOpen: true })).toEqual({ show: true, autoOpen: true });
    expect(decide({ autoOpen: true, attended: false }).autoOpen).toBe(false);
    expect(decide({ autoOpen: true, hasRoom: false }).autoOpen).toBe(false);
  });
});

describe("paneOfferLabel", () => {
  test("the agent's title wins, the host is the fallback", () => {
    expect(paneOfferLabel({ ...fresh, title: "Storybook" })).toBe("Storybook");
    expect(paneOfferLabel(fresh)).toBe("localhost:3000");
    expect(paneOfferLabel({ ...fresh, title: "   " })).toBe("localhost:3000");
  });
});

describe("paneOfferHint", () => {
  test("a loopback address names the machine that serves it", () => {
    expect(paneOfferHint(fresh, "Ashot's MacBook")).toContain("served by Ashot's MacBook");
    expect(paneOfferHint(fresh, null)).not.toContain("served by");
    expect(paneOfferHint({ url: "https://example.com/", offered_at: NOW }, "Ashot's MacBook")).not.toContain("served by");
  });
});
