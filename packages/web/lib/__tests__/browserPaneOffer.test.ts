import { describe, expect, test } from "bun:test";
import { PANE_OFFER_TTL_MS } from "@codecast/shared/contracts/browserPaneOffer";
import { paneOfferDecision, paneOfferLabel, paneOfferHint, paneOfferOwner } from "../browserPaneOffer";

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
  });

  test("a full stage keeps the chip and refuses to open it for the reader", () => {
    // hasRoom counts the pane cap (lib/stage stageHasRoom), so this is the
    // stage that is wide enough but already holds four panes. The offer must
    // stay clickable and must NOT open itself — opening would fall back to
    // navigating the tab, moving the view nobody asked to move.
    expect(decide({ autoOpen: true, hasRoom: false })).toEqual({ show: true, autoOpen: false });
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

describe("paneOfferOwner", () => {
  const SID = "4380da23-ff4c-48a2-b4cc-653a9a8148e3";
  const now = 1_700_000_000_000;
  const offer = { url: "https://example.com/", offered_at: now - 1000 };

  test("the hinted session owns the pane only when its row holds a live offer for that address", () => {
    const rows = [{ session_id: SID, browser_pane_offer: offer }];
    expect(paneOfferOwner({ hinted: SID, url: "https://example.com", rows, now })).toBe(SID);
  });

  test("a hand-typed s= naming a session with no such offer stamps nobody", () => {
    const rows = [{ session_id: SID, browser_pane_offer: offer }];
    expect(paneOfferOwner({ hinted: "0000-other-session", url: "https://example.com/", rows, now })).toBeUndefined();
    expect(paneOfferOwner({ hinted: SID, url: "https://evil.example/", rows, now })).toBeUndefined();
  });

  test("an offer already handled, or expired, no longer grants ownership", () => {
    const handled = [{ session_id: SID, browser_pane_offer: { ...offer, opened_at: now - 10 } }];
    expect(paneOfferOwner({ hinted: SID, url: offer.url, rows: handled, now })).toBeUndefined();
    const stale = [{ session_id: SID, browser_pane_offer: { ...offer, offered_at: now - 3 * 24 * 3600 * 1000 } }];
    expect(paneOfferOwner({ hinted: SID, url: offer.url, rows: stale, now })).toBeUndefined();
  });

  test("no hint, no owner; missing rows are skipped", () => {
    expect(paneOfferOwner({ hinted: undefined, url: offer.url, rows: [], now })).toBeUndefined();
    expect(paneOfferOwner({ hinted: SID, url: offer.url, rows: [undefined, { session_id: SID, browser_pane_offer: offer }], now })).toBe(SID);
  });
});
