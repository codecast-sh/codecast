import { describe, expect, test } from "bun:test";
import { replayCaptureProblem } from "../contracts/replayPlayer";
import { readVendorCapture } from "./capture";
import { fromMobileWireframes, isMobileCapture, MOBILE_BODY_ID } from "./mobile";
import { mobileRecording } from "./mobile.fixture";
import { renderTimeline } from "./timeline";
import { replayMoment } from "./moment";

/** Every node of a serialized tree, depth first. */
function nodes(n: any, out: any[] = []): any[] {
  if (!n) return out;
  out.push(n);
  for (const c of n.childNodes ?? []) nodes(c, out);
  return out;
}
const byTag = (all: any[], tag: string) => all.filter((n) => n.tagName === tag);
const textOf = (n: any): string => nodes(n).filter((x) => x.type === 3).map((x) => x.textContent).join(" ");

describe("isMobileCapture", () => {
  test("knows wireframes from a DOM", () => {
    expect(isMobileCapture(mobileRecording())).toBe(true);
    expect(isMobileCapture([{ type: 2, timestamp: 1, data: { node: { type: 0, id: 1, childNodes: [] } } }])).toBe(false);
    // A recording whose first part is a mutation of wireframes (the read began after the snapshot).
    expect(isMobileCapture([{ type: 3, timestamp: 1, data: { source: 0, updates: [{ parentId: 0, wireframe: { id: 1, type: "text" } }] } }])).toBe(true);
  });
});

describe("fromMobileWireframes", () => {
  const { events } = fromMobileWireframes(mobileRecording());
  const full = events.find((e) => e.type === 2)!;
  const all = nodes(full.data.node);

  test("a full snapshot becomes a document rrweb rebuilds: html, head, body, every box positioned", () => {
    expect(replayCaptureProblem(events)).toBeNull();
    expect(full.data.node.type).toBe(0);
    expect(byTag(all, "html")).toHaveLength(1);
    expect(byTag(all, "body")[0].id).toBe(MOBILE_BODY_ID);
    const welcome = all.find((n) => n.tagName === "div" && textOf(n) === "Welcome back");
    expect(welcome.attributes.style).toContain("position:fixed");
    expect(welcome.attributes.style).toContain("left:24px");
    expect(welcome.attributes.style).toContain("top:120px");
    expect(welcome.attributes.style).toContain("font-size:28px");
    expect(byTag(all, "img")[0].attributes.src).toStartWith("data:image/png;base64,iVBOR");
    const inputs = byTag(all, "input");
    expect(inputs.map((i) => i.attributes.type)).toEqual(["email", "password"]);
  });

  test("ids are unique, so a synthetic node never takes a real view's id", () => {
    const ids = all.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a style value cannot close its declaration or name a remote image", () => {
    const json = JSON.stringify(events);
    expect(json).not.toContain("evil.test");
    expect(json).toContain("border-radius:12px");
  });

  test("the status bar is lifted above the app", () => {
    const body = byTag(all, "body")[0];
    const last = body.childNodes[body.childNodes.length - 1];
    expect(last.childNodes).toHaveLength(1);
    expect(byTag(all, "div").filter((d) => d.attributes.style?.includes("height:47px"))).toHaveLength(1);
  });

  test("an update is a removal and a flattened add, parents first", () => {
    const update = events.find((e) => e.timestamp === 1_760_000_003_200)!;
    const adds = update.data.adds as any[];
    for (const a of adds) if (Array.isArray(a.node.childNodes)) expect(a.node.childNodes).toHaveLength(0);
    const seen = new Set<number>([MOBILE_BODY_ID]);
    for (const a of adds) {
      expect(seen.has(a.parentId)).toBe(true);
      seen.add(a.node.id);
    }
    const root = full.data.node.childNodes[1].childNodes[1].childNodes[0];
    expect(update.data.removes.map((r: any) => r.id)).toContain(root.id);
    expect(adds[0].node.id).toBe(root.id);
    expect(adds.some((a) => a.node.textContent === "Order #1042 shipped")).toBe(true);
  });

  test("a tap becomes a click on the box under the finger; a swipe does not", () => {
    const clicks = events.filter((e) => e.type === 3 && e.data.source === 2 && e.data.type === 2);
    expect(clicks).toHaveLength(1);
    const target = all.find((n) => n.id === clicks[0].data.id);
    expect(textOf(target)).toBe("Sign in");
    // The touches themselves stay, aimed at a node that exists.
    const touches = events.filter((e) => e.type === 3 && e.data.source === 2 && e.data.type !== 2);
    expect(touches).toHaveLength(4);
    for (const t of touches) expect(t.data.id).not.toBe(0);
  });

  test("every Meta after the first screen is followed by a full snapshot, so rrweb can seek past a screen change", () => {
    const metas = events.map((e, i) => [e, i] as const).filter(([e]) => e.type === 4).slice(1);
    expect(metas).toHaveLength(1);
    for (const [, i] of metas) expect(events[i + 1].type).toBe(2);
    // The redrawn screen is the model at that moment: still the login screen, keyboard closed.
    const redrawn = nodes(events[metas[0][1] + 1].data.node);
    expect(redrawn.some((n) => n.textContent === "Welcome back")).toBe(true);
    expect(redrawn.some((n) => n.id === 10)).toBe(false);
  });

  test("the keyboard shows and hides as a box at the bottom", () => {
    const kb = events.filter((e) => e.timestamp === 1_760_000_002_500 || e.timestamp === 1_760_000_003_000);
    expect(kb[0].data.adds[0].node.attributes.style).toContain("bottom:0");
    expect(kb[1].data.removes).toEqual([{ parentId: 9, id: 10 }]);
  });
});

describe("mutations name the drawn page's nodes", () => {
  const box = (id: number, extra: Record<string, unknown> = {}) => ({ id, x: 0, y: 0, width: 100, height: 40, type: "rectangle", ...extra });
  const start = (wireframes: unknown[]) => [
    { type: 4, timestamp: 1, data: { href: "Screen", width: 393, height: 852 } },
    { type: 2, timestamp: 2, data: { wireframes, initialOffset: { top: 0, left: 0 } } },
  ];
  const mutation = (timestamp: number, data: Record<string, unknown>) => ({ type: 3, timestamp, data: { source: 0, ...data } });
  const drawnIds = (events: any[]) => new Set(nodes(events.find((e) => e.type === 2).data.node).map((n) => n.id));

  test("a removes-only mutation is mapped to our ids and drops the box from the screen model", () => {
    // Wireframe id 5 would be the body if it passed through raw.
    const input = [...start([box(1, { childWireframes: [box(5, { type: "text", text: "Gone soon", x: 10, y: 10, width: 50, height: 20 }), box(6, { type: "text", text: "Stays", x: 60, y: 10, width: 30, height: 20 })] })]), mutation(3, { removes: [{ parentId: 1, id: 5 }] }), { type: 3, timestamp: 4, data: { source: 2, type: 7, x: 20, y: 20 } }, { type: 3, timestamp: 5, data: { source: 2, type: 9, x: 20, y: 20 } }];
    const { events, views } = fromMobileWireframes(input as any);
    const full = events.find((e) => e.type === 2)!;
    const all = nodes(full.data.node);
    const parentOf = (child: any) => all.find((n) => n.childNodes?.includes(child));
    const text = parentOf(all.find((n) => n.type === 3 && n.textContent === "Gone soon"));
    const outer = parentOf(text);
    const removal = events.find((e) => e.timestamp === 3)!;
    expect(removal.data.removes).toEqual([{ parentId: outer.id, id: text.id }]);
    expect(text.id).not.toBe(MOBILE_BODY_ID);
    // The tap after the removal lands on the outer box, not the deleted one.
    const click = events.find((e) => e.type === 3 && e.data.source === 2 && e.data.type === 2)!;
    expect(click.data.id).toBe(outer.id);
    expect(views.at(-1)?.outline).toBe("Stays");
  });

  test("a removal of a wireframe nobody drew is dropped rather than passed through", () => {
    const { events } = fromMobileWireframes([...start([box(1)]), mutation(3, { removes: [{ parentId: 1, id: 2 }] })] as any);
    expect(events.find((e) => e.timestamp === 3)!.data.removes).toEqual([]);
  });

  test("a labelled checkbox is one node under the wireframe's id, so an update replaces its label too", () => {
    const check = (checked: boolean) => ({ id: 7, x: 0, y: 0, width: 200, height: 30, type: "input", inputType: "checkbox", checked, label: "Remember me" });
    const { events } = fromMobileWireframes([...start([box(1, { width: 393, height: 400, childWireframes: [check(false)] })]), mutation(3, { updates: [{ parentId: 1, wireframe: check(true) }] })] as any);
    const all = nodes(events.find((e) => e.type === 2)!.data.node);
    const label = all.find((n) => n.tagName === "label");
    const parent = all.find((n) => n.childNodes?.includes(label));
    const update = events.find((e) => e.timestamp === 3)!;
    expect(update.data.removes).toEqual([{ parentId: parent.id, id: label.id }]);
    const added = update.data.adds as any[];
    expect(added[0]).toMatchObject({ parentId: parent.id, node: { id: label.id, tagName: "label" } });
    expect(added.filter((a) => a.node.textContent === "Remember me")).toHaveLength(1);
    expect(added.find((a) => a.node.tagName === "input").parentId).toBe(label.id);
  });

  test("a bar in a mutation replaces the one in its slot, above the app", () => {
    const bar = (id: number, color: string) => ({ id, x: 0, y: 0, width: 393, height: 47, type: "status_bar", style: { backgroundColor: color } });
    const { events } = fromMobileWireframes([...start([bar(2, "#ffffff"), box(1)]), mutation(3, { adds: [{ parentId: 1, wireframe: bar(3, "#000000") }] }), mutation(4, { removes: [{ parentId: 0, id: 3 }] })] as any);
    const slot = 11;
    const old = nodes(events.find((e) => e.type === 2)!.data.node).find((n) => n.attributes?.style?.includes("#ffffff"));
    const swap = events.find((e) => e.timestamp === 3)!;
    expect(swap.data.removes).toEqual([{ parentId: slot, id: old.id }]);
    expect(swap.data.adds).toHaveLength(1);
    expect(swap.data.adds[0].parentId).toBe(slot);
    expect(swap.data.adds[0].node.attributes.style).toContain("#000000");
    expect(events.find((e) => e.timestamp === 4)!.data.removes).toEqual([{ parentId: slot, id: swap.data.adds[0].node.id }]);
  });

  test("ids stay unique across the whole converted recording", () => {
    const { events } = fromMobileWireframes(mobileRecording());
    const live = drawnIds(events);
    for (const e of events.filter((x) => x.type === 3 && x.data.source === 0)) {
      for (const r of e.data.removes) live.delete(r.id);
      for (const a of e.data.adds) {
        expect(live.has(a.node.id)).toBe(false);
        live.add(a.node.id);
      }
    }
  });
});

describe("readVendorCapture on a mobile recording", () => {
  const capture = readVendorCapture(mobileRecording());

  test("keeps a capture the player can draw, masked like any page", () => {
    expect(capture.format).toBe("mobile");
    expect(capture.dom).not.toBeNull();
    const json = JSON.stringify(capture.dom);
    for (const secret of ["ada@example.com", "hunter2", "leave at the back door"]) expect(json).not.toContain(secret);
    expect(json).toContain("Welcome back");
    expect(json).toContain("***************");
  });

  test("the stream names screens, the tap and the error, and outlines each screen without a field's value", () => {
    const s = capture.events;
    expect(s.filter((e) => e.type === "nav").map((e: any) => e.url)).toEqual(["LoginScreen", "OrdersScreen"]);
    const click = s.find((e) => e.type === "click") as any;
    expect(click.label).toBe("Sign in");
    expect(click.t).toBe(2_090);
    const views = s.filter((e) => e.type === "view") as any[];
    expect(views[0].outline.split("\n")).toEqual(["Welcome back", "Sign in to continue", "[field]", "Sign in"]);
    expect(views.some((v) => v.outline.includes("Your orders") && v.outline.includes("[toggle on] Notifications") && v.outline.includes("[button] Track order"))).toBe(true);
    // A row added later reaches the outline taken before the error.
    const beforeError = views.filter((v) => v.t <= 7_000).pop();
    expect(beforeError.outline).toContain("Order #1040 returned");
    for (const v of views) {
      expect(v.outline).not.toContain("hunter2");
      expect(v.outline).not.toContain("back door");
      expect(v.outline).not.toContain("token");
    }
    expect(s.some((e) => e.type === "console" && e.message === "Order fetch failed: 500")).toBe(true);
  });

  test("the timeline and a moment read it like a web recording", () => {
    const md = renderTimeline(capture.events);
    expect(md).toContain('click "Sign in"');
    expect(md).toContain("nav /OrdersScreen");
    const m = replayMoment(capture.events, 7_000);
    expect(m.url).toBe("OrdersScreen");
    expect(m.outline).toContain("Order #1040 returned");
  });
});

describe("a capture that cannot be drawn", () => {
  test("is not kept, and the player says why instead of drawing white", () => {
    const unknown = [{ type: 4, timestamp: 1, data: { href: "https://a.test/" } }, { type: 2, timestamp: 2, data: { screen: "something new" } }];
    expect(readVendorCapture(unknown as any).dom).toBeNull();
    expect(replayCaptureProblem(unknown)).toContain("cannot draw");
    expect(replayCaptureProblem([{ type: 4, timestamp: 1, data: {} }])).toContain("no full snapshot");
    // A mobile recording stored as wireframes by an older import.
    expect(replayCaptureProblem([{ type: 2, timestamp: 1, data: { wireframes: [] } }])).toContain("mobile recording");
  });
});
