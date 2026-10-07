import { describe, expect, test } from "bun:test";
import { domCapturePlayable, prepareDomCapture } from "./dom";

const snapshot = (children: any[]) => ({ type: 2, timestamp: 10, data: { node: { type: 0, id: 1, childNodes: children } } });
const el = (id: number, tagName: string, attributes: Record<string, unknown> = {}, childNodes: any[] = []) => ({ type: 2, id, tagName, attributes, childNodes });
const text = (id: number, textContent: string) => ({ type: 3, id, textContent });

describe("prepareDomCapture", () => {
  test("keeps valid events in time order and drops the rest", () => {
    const out = prepareDomCapture([{ type: 3, timestamp: 20, data: {} }, null as any, { type: "x", timestamp: 1 } as any, { type: 4, timestamp: 5, data: { href: "https://a.test/" } }]);
    expect(out.map((e) => e.timestamp)).toEqual([5, 20]);
  });

  test("no typed value survives: input events, value attributes, textarea text", () => {
    const events = [
      snapshot([el(2, "input", { value: "hunter2", type: "password" }), el(3, "textarea", {}, [text(4, "my notes")]), el(5, "select", { value: "visa" })]),
      { type: 3, timestamp: 11, data: { source: 5, id: 2, text: "hunter22" } },
      { type: 3, timestamp: 12, data: { source: 0, adds: [], removes: [], texts: [{ id: 4, value: "my notes!" }], attributes: [{ id: 2, attributes: { value: "x" } }, { id: 9, attributes: { value: "kept" } }] } },
    ];
    const out = JSON.stringify(prepareDomCapture(events));
    for (const secret of ["hunter2", "my notes", "visa"]) expect(out).not.toContain(secret);
    expect(out).toContain("*******");
    // A value attribute on something that is not a field is the page's own markup.
    expect(out).toContain("kept");
    // Lengths are kept so the layout replays as it looked.
    expect((events[1] as any).data.text).toBe("********");
  });

  test("private and editable regions keep their shape, not their words, including text added later", () => {
    const events = [
      snapshot([el(2, "div", { "data-private": "" }, [text(3, "Ada Lovelace, 4111 1111")]), el(4, "div", { contenteditable: "true" }, [text(5, "draft")]), el(6, "p", {}, [text(7, "Public copy")])]),
      { type: 3, timestamp: 11, data: { source: 0, adds: [{ parentId: 2, node: el(8, "span", {}, [text(9, "new secret")]) }, { parentId: 6, node: text(10, "more public") }], removes: [], texts: [{ id: 9, value: "edited secret" }], attributes: [] } },
      { type: 3, timestamp: 12, data: { source: 0, adds: [], removes: [], texts: [{ id: 3, value: "Grace Hopper" }], attributes: [] } },
    ];
    const out = JSON.stringify(prepareDomCapture(events));
    for (const secret of ["Ada", "draft", "new secret", "edited secret", "Grace"]) expect(out).not.toContain(secret);
    expect(out).toContain("Public copy");
    expect(out).toContain("more public");
  });

  test("a full snapshot starts the bookkeeping over", () => {
    const events = [
      snapshot([el(2, "div", { class: "rr-block" }, [text(3, "hidden")])]),
      { ...snapshot([el(2, "div", {}, [text(3, "shown")])]), timestamp: 20 },
      { type: 3, timestamp: 21, data: { source: 0, adds: [], removes: [], texts: [{ id: 3, value: "still shown" }], attributes: [] } },
    ];
    const out = JSON.stringify(prepareDomCapture(events));
    expect(out).not.toContain("hidden");
    expect(out).toContain("still shown");
  });

  test("a Meta href keeps its query keys, not their values", () => {
    const [meta] = prepareDomCapture([{ type: 4, timestamp: 1, data: { href: "https://shop.test/cart?token=abc#x", width: 800, height: 600 } }]);
    expect(meta.data.href).toBe("https://shop.test/cart?token=#");
  });

  test("is playable only with a full snapshot", () => {
    expect(domCapturePlayable([{ type: 4, timestamp: 1 }])).toBe(false);
    expect(domCapturePlayable([{ type: 4, timestamp: 1 }, snapshot([])])).toBe(true);
  });
});
