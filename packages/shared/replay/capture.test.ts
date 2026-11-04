import { describe, expect, test } from "bun:test";
import { carryFromCapture, readVendorCapture, readVendorCapturePart } from "./capture";
import type { RrwebEvent } from "./rrweb";

// A recording as PostHog hands it over: a stray event long before the page
// was drawn, then a page that a person used briefly and left open.
function recording(): RrwebEvent[] {
  const T = 1_793_700_000_000;
  const node = { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: "html", attributes: {}, childNodes: [{ type: 2, id: 3, tagName: "body", attributes: {}, childNodes: [{ type: 2, id: 4, tagName: "button", attributes: {}, childNodes: [{ type: 3, id: 5, textContent: "Join" }] }] }] }] };
  return [
    { type: 5, timestamp: T, data: { tag: "$pageview", payload: {} } },
    { type: 4, timestamp: T + 2_449_300, data: { href: "https://app.test/worker", width: 900, height: 900 } },
    { type: 2, timestamp: T + 2_449_301, data: { node, initialOffset: { top: 0, left: 0 } } },
    { type: 3, timestamp: T + 2_457_200, data: { source: 2, type: 2, id: 4 } },
    // The page keeps mutating for five more minutes after the click.
    { type: 3, timestamp: T + 2_757_200, data: { source: 0, adds: [], removes: [], texts: [], attributes: [] } },
  ];
}

describe("a vendor capture's clock", () => {
  test("the capture's end is on the events' base, so a page left open keeps its length", () => {
    const c = readVendorCapture(recording());
    const first = c.events[0].t;
    expect(first).toBe(2_449_300);
    expect(c.end_t).toBe(2_757_200);
    // On the replay clock (zero at the first event, where dom_t0 + first_t puts the player), every
    // event falls inside the capture: what the rail seeks to is a frame the player can draw.
    const captureLen = c.end_t - first;
    for (const e of c.events) {
      expect(e.t - first).toBeGreaterThanOrEqual(0);
      expect(e.t - first).toBeLessThanOrEqual(captureLen + 1_000);
    }
    expect(captureLen).toBe(307_900);
    // The capture's own zero is the stream's: the player maps dom[0] + first_t to clock 0.
    expect(c.dom![0].timestamp + first).toBe(recording()[1].timestamp);
  });
});

describe("a long recording read in parts", () => {
  const T = 1_793_800_000_000;
  function whole(): RrwebEvent[] {
    const node = { type: 0, id: 1, childNodes: [{ type: 2, id: 2, tagName: "body", attributes: {}, childNodes: [
      { type: 2, id: 3, tagName: "textarea", attributes: {}, childNodes: [] },
    ] }] };
    return [
      { type: 4, timestamp: T, data: { href: "https://app.test/queue?x=1", width: 1200, height: 800 } },
      { type: 2, timestamp: T + 10, data: { node } },
      { type: 3, timestamp: T + 1_000, data: { source: 0, adds: [
        { parentId: 2, nextId: null, node: { type: 2, id: 20, tagName: "button", attributes: {}, childNodes: [] } },
        { parentId: 20, nextId: null, node: { type: 3, id: 21, textContent: "Claim" } },
      ], removes: [], texts: [], attributes: [] } },
      // The part boundary falls here: everything below reads with what the part above left.
      { type: 3, timestamp: T + 60_000, data: { source: 2, type: 2, id: 20 } },
      { type: 3, timestamp: T + 61_000, data: { source: 0, adds: [{ parentId: 3, nextId: null, node: { type: 3, id: 30, textContent: "my note" } }], removes: [], texts: [], attributes: [] } },
      { type: 6, timestamp: T + 62_000, data: { plugin: "rrweb/network@1", payload: { requests: [{ name: "/api/claim", method: "POST", responseStatus: 500, startTime: 0, endTime: 10 }] } } },
    ];
  }

  test("the parts convert as one pass would, on one clock, masked the same", () => {
    const one = readVendorCapture(whole());
    const all = whole();
    const first = readVendorCapture(all.slice(0, 3));
    expect(first.carry).not.toBeNull();
    const rest = readVendorCapturePart(all.slice(3), first.carry!);
    const parts = [...first.events, ...rest.events];
    expect(parts).toEqual(one.events);
    expect(parts.find((e) => e.type === "click")).toMatchObject({ t: 59_990 + 10, label: "Claim" });
    // The textarea was seen in the first part; text added under it in the second is still masked.
    expect(JSON.stringify(rest.dom)).not.toContain("my note");
    expect(rest.end_t).toBe(62_000);
    // The carry survives the trip through storage as JSON.
    const again = readVendorCapturePart(whole().slice(3), JSON.parse(JSON.stringify(first.carry)));
    expect(again.events).toEqual(rest.events);
  });

  test("a carry rebuilt from the stored capture reads the next part as the kept one would", () => {
    const all = whole();
    const first = readVendorCapture(all.slice(0, 3));
    const kept = readVendorCapturePart(all.slice(3), first.carry!);
    // The kept carry is lost: rebuild it from the masked capture the first part stored.
    const rebuilt = carryFromCapture(first.dom!, first.carry!.converter.t0);
    expect(rebuilt).not.toBeNull();
    const rest = readVendorCapturePart(whole().slice(3), rebuilt!);
    expect(rest.events).toEqual(kept.events);
    expect(rest.events.find((e) => e.type === "click")).toMatchObject({ label: "Claim" });
    expect(JSON.stringify(rest.dom)).not.toContain("my note");
  });

  test("no full snapshot in the stored capture: nothing to rebuild from", () => {
    expect(carryFromCapture(whole().filter((e) => e.type !== 2), T)).toBeNull();
  });
});
