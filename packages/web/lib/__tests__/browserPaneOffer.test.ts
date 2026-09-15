import { describe, expect, test } from "bun:test";
import { PANE_OFFER_TTL_MS } from "@codecast/shared/contracts/browserPaneOffer";
import { OPENED_GRACE_MS, paneOfferDecision, paneOfferLabel, paneOfferHint, paneOfferOwner } from "../browserPaneOffer";

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

  test("the click that opened the pane stamps the offer handled a beat before the pane mounts; that pane still owns it", () => {
    const justClicked = [{ session_id: SID, browser_pane_offer: { ...offer, opened_at: now - 10 } }];
    expect(paneOfferOwner({ hinted: SID, url: offer.url, rows: justClicked, now })).toBe(SID);
  });

  test("an offer handled longer ago, or expired, no longer grants ownership", () => {
    const handled = [{ session_id: SID, browser_pane_offer: { ...offer, opened_at: now - OPENED_GRACE_MS - 1 } }];
    expect(paneOfferOwner({ hinted: SID, url: offer.url, rows: handled, now })).toBeUndefined();
    const stale = [{ session_id: SID, browser_pane_offer: { ...offer, offered_at: now - 3 * 24 * 3600 * 1000 } }];
    expect(paneOfferOwner({ hinted: SID, url: offer.url, rows: stale, now })).toBeUndefined();
  });

  test("no hint, no owner; missing rows are skipped", () => {
    expect(paneOfferOwner({ hinted: undefined, url: offer.url, rows: [], now })).toBeUndefined();
    expect(paneOfferOwner({ hinted: SID, url: offer.url, rows: [undefined, { session_id: SID, browser_pane_offer: offer }], now })).toBe(SID);
  });
});

describe("paneOfferOwner across the chip's click-then-mount sequence", () => {
  const SID = "4380da23-ff4c-48a2-b4cc-653a9a8148e3";
  const t0 = 1_700_000_000_000;

  test("the chip stamps handled at the click, the pane mounts later, ownership holds; a day later the same link stamps nobody", () => {
    // The chip's open(): openBrowserPane(...) then dismiss(conversationId, now).
    const row = { session_id: SID, browser_pane_offer: { url: "http://localhost:8765/", offered_at: t0 - 5000, opened_at: t0 } };
    // The pane mounts a beat after the click, reads the store: still the owner.
    expect(paneOfferOwner({ hinted: SID, url: "http://localhost:8765", rows: [row], now: t0 + 400 })).toBe(SID);
    // A second window painting the same route inside the grace: also fine, it is the same click.
    expect(paneOfferOwner({ hinted: SID, url: "http://localhost:8765", rows: [row], now: t0 + OPENED_GRACE_MS - 1 })).toBe(SID);
    // The saved link, pasted tomorrow: the offer is history, nobody is stamped.
    expect(paneOfferOwner({ hinted: SID, url: "http://localhost:8765", rows: [row], now: t0 + 24 * 3600 * 1000 })).toBeUndefined();
    // A pasted link naming another session against that same row: never.
    expect(paneOfferOwner({ hinted: "1111-not-the-offering-session", url: "http://localhost:8765", rows: [row], now: t0 + 400 })).toBeUndefined();
  });
});
