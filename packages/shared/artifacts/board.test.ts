import { describe, expect, test } from "bun:test";
import { artifactView } from "./spec";
import { foldOps, toElement, type ArtifactElement, type ArtifactOp, type ElementState } from "./core";
import {
  alignBoxes,
  anchorPoint,
  boardSpec,
  connectorGeometry,
  distributeBoxes,
  elementBox,
  gridPositions,
  parseItem,
  parseThemes,
  parseTimeline,
  parseVerbArgs,
  simplifyStroke,
  snapBox,
  stickyFontSize,
  BOARD_TEMPLATES,
  BOARD_VERBS,
} from "./board";

function el(key: string, kind: string, fields: Record<string, any>): ArtifactElement {
  return { key, kind, rev: 1, ...fields } as ArtifactElement;
}

function board(els: ArtifactElement[]) {
  return artifactView("board", "Launch", els);
}

/** Apply a verb's ops to a view and return the next view. */
function run(view: ReturnType<typeof board>, verb: string, args: string[], stdin?: string) {
  const res = boardSpec.verbs![verb].run(view, args, stdin);
  const state = new Map<string, ElementState>();
  for (const e of view.elements) state.set(e.key, { kind: e.kind, fields: Object.fromEntries(Object.entries(e).filter(([f]) => !["key", "kind", "rev", "by", "at"].includes(f))) as any });
  foldOps(state, res.ops);
  const next = [...state].filter(([, s]) => !s.deleted).map(([k, s]) => toElement(k, s));
  return { res, view: board(next) };
}

describe("parseItem", () => {
  test("plain line is a yellow sticky with title and body", () => {
    const it = parseItem("Lock flavor | Huckleberry it is")!;
    expect(it.kind).toBe("sticky");
    expect(it.fields).toEqual({ text: "Lock flavor\nHuckleberry it is", color: "yellow" });
  });
  test("variants and a leading emoji icon", () => {
    const it = parseItem("sticky:green 🫐 Lock flavor")!;
    expect(it.fields).toMatchObject({ color: "green", icon: "🫐", text: "Lock flavor" });
    expect(it.h).toBe(200);
    expect(parseItem("shape:diamond:blue Ship?")!.fields).toMatchObject({ shape: "diamond", color: "blue", text: "Ship?" });
    expect(parseItem("text:36 Heading")!.fields).toMatchObject({ size: 36, text: "Heading" });
  });
  test("cards, stamps, comments and blanks", () => {
    expect(parseItem("card ct-4102")!.fields).toEqual({ ref: "ct-4102" });
    expect(parseItem("stamp 🎉")!.fields).toEqual({ emoji: "🎉" });
    expect(parseItem("# note")).toBeNull();
    expect(parseItem("   ")).toBeNull();
    expect(parseItem("card")).toBeNull();
  });
  test("a word that is not a kind stays text", () => {
    expect(parseItem("ship it")!.fields.text).toBe("ship it");
  });
});

describe("args", () => {
  test("flags, inline values and booleans", () => {
    expect(parseVerbArgs(["a", "--gap", "40", "--curved", "b", "--at=1,2"], ["curved"])).toEqual({
      pos: ["a", "b"],
      flags: { gap: "40", curved: true, at: "1,2" },
    });
  });
});

describe("geometry", () => {
  test("anchor leaves a rect on its edge and an ellipse on its curve", () => {
    const b = { x: 0, y: 0, w: 200, h: 100 };
    expect(anchorPoint(b, "rect", { x: 500, y: 50 })).toEqual({ x: 200, y: 50 });
    expect(anchorPoint(b, "rect", { x: 100, y: -400 })).toEqual({ x: 100, y: 0 });
    const e = anchorPoint(b, "ellipse", { x: 400, y: 250 });
    expect(((e.x - 100) / 100) ** 2 + ((e.y - 50) / 50) ** 2).toBeCloseTo(1, 5);
    const d = anchorPoint(b, "diamond", { x: 400, y: 250 });
    expect(Math.abs(d.x - 100) / 100 + Math.abs(d.y - 50) / 50).toBeCloseTo(1, 5);
  });

  test("connectors follow their ends as they move", () => {
    const a = el("a", "sticky", { x: 0, y: 0, w: 200, h: 160 });
    const b = el("b", "sticky", { x: 400, y: 0, w: 200, h: 160 });
    const c = el("c", "connector", { from: "a", to: "b" });
    const g1 = connectorGeometry(c, (k) => ({ a, b } as any)[k])!;
    expect(g1.a.x).toBe(204);
    expect(g1.b.x).toBe(396);
    const moved = { ...b, y: 300 };
    const g2 = connectorGeometry(c, (k) => ({ a, b: moved } as any)[k])!;
    expect(g2.b.y).toBeGreaterThan(g1.b.y);
    expect(connectorGeometry(el("d", "connector", { from: "a", to: "gone" }), (k) => ({ a } as any)[k])).toBeNull();
  });

  test("curved connector path is a cubic", () => {
    const a = el("a", "shape", { x: 0, y: 0, w: 100, h: 100 });
    const b = el("b", "shape", { x: 300, y: 200, w: 100, h: 100 });
    const g = connectorGeometry(el("c", "connector", { from: "a", to: "b", curve: "curved" }), (k) => ({ a, b } as any)[k])!;
    expect(g.d.startsWith("M")).toBe(true);
    expect(g.d).toContain(" C");
  });

  test("text and pen boxes derive from content", () => {
    const t = elementBox(el("t", "text", { x: 10, y: 10, text: "hello", size: 20 }));
    expect(t.w).toBeGreaterThan(50);
    expect(t.h).toBe(26);
    const p = elementBox(el("p", "pen", { x: 100, y: 100, points: [0, 0, 50, 20], width: 4 }));
    expect(p).toEqual({ x: 98, y: 98, w: 54, h: 24 });
  });

  test("snapping finds the nearest edge and center within threshold", () => {
    const s = snapBox({ x: 103, y: 500, w: 100, h: 100 }, [{ x: 100, y: 0, w: 100, h: 100 }], 6);
    expect(s.dx).toBe(-3);
    expect(s.dy).toBe(0);
    expect(s.guides[0]).toMatchObject({ axis: "x", at: 100 });
    expect(snapBox({ x: 120, y: 500, w: 100, h: 100 }, [{ x: 100, y: 0, w: 60, h: 60 }], 6).guides).toHaveLength(0);
  });

  test("align and distribute", () => {
    const boxes = new Map([["a", { x: 0, y: 0, w: 100, h: 50 }], ["b", { x: 300, y: 80, w: 50, h: 50 }], ["c", { x: 120, y: 40, w: 20, h: 20 }]]);
    expect(alignBoxes(boxes, "right").get("a")!.x).toBe(250);
    expect(alignBoxes(boxes, "top").get("b")!.y).toBe(0);
    const dist = distributeBoxes(boxes, "h");
    // span 0..350, widths 170 -> two gaps of 90
    expect(dist.get("c")!.x).toBe(190);
  });

  test("grid rows take their tallest item", () => {
    const p = gridPositions([{ w: 100, h: 50 }, { w: 100, h: 90 }, { w: 100, h: 10 }], { cols: 2, gap: 10, at: { x: 0, y: 0 } });
    expect(p).toEqual([{ x: 0, y: 0 }, { x: 110, y: 0 }, { x: 0, y: 100 }]);
  });

  test("stroke simplify keeps corners and drops straight runs", () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplifyStroke(line)).toHaveLength(2);
    const corner = [...line, ...Array.from({ length: 50 }, (_, i) => ({ x: 49, y: i + 1 }))];
    expect(simplifyStroke(corner)).toHaveLength(3);
  });

  test("sticky text shrinks to fit", () => {
    expect(stickyFontSize("short", 200, 160)).toBe(22);
    expect(stickyFontSize("a much longer sticky ".repeat(12), 200, 160)).toBeLessThan(14);
  });
});

describe("verbs", () => {
  test("place a grid below existing content, each above the last", () => {
    const v = board([el("el_a", "sticky", { x: 0, y: 0, w: 200, h: 160, z: 3 })]);
    const { res, view } = run(v, "place", ["grid", "--cols", "2"], "One\nTwo\nThree");
    expect(res.ops).toHaveLength(3);
    const placed = view.elements.filter((e) => e.key !== "el_a").sort((a, b) => (a.z as number) - (b.z as number));
    expect(placed.map((e) => [e.x, e.y, e.z])).toEqual([[0, 280, 4], [240, 280, 5], [0, 480, 6]]);
    expect(res.position?.point).toBeDefined();
  });

  test("place with a frame wraps the items", () => {
    const { view } = run(board([]), "place", ["row", "--frame", "Ideas", "--at", "0,0"], "a\nb");
    const frame = view.elements.find((e) => e.kind === "frame")!;
    const fb = elementBox(frame);
    for (const s of view.elements.filter((e) => e.kind === "sticky")) {
      const b = elementBox(s);
      expect(b.x >= fb.x && b.y >= fb.y && b.x + b.w <= fb.x + fb.w && b.y + b.h <= fb.y + fb.h).toBe(true);
    }
  });

  test("timeline: road under everything, a pill and a stemmed card per stop, cards alternate", () => {
    const stops = parseTimeline("Day 1 | Lock flavor | Huckleberry it is | 🫐\nDay 2 | Lock pricing | What's a pie cost? | 💲\nDay 3 | Place order | 23 tons | 📦 | green");
    expect(stops[2]).toEqual({ label: "Day 3", title: "Place order", body: "23 tons", icon: "📦", color: "green" });
    const { view } = run(board([]), "timeline", ["--title", "Launch Timeline", "--subtitle", "12 days"], stops.map((s) => `${s.label} | ${s.title} | ${s.body} | ${s.icon}`).join("\n"));
    const kinds = view.elements.map((e) => e.kind).sort();
    expect(kinds.filter((k) => k === "sticky")).toHaveLength(3);
    expect(kinds.filter((k) => k === "shape")).toHaveLength(3);
    expect(kinds.filter((k) => k === "connector")).toHaveLength(3);
    expect(kinds.filter((k) => k === "pen")).toHaveLength(1);
    expect(kinds.filter((k) => k === "text")).toHaveLength(2);
    const road = view.elements.find((e) => e.kind === "pen")!;
    expect(Math.min(...view.elements.map((e) => (typeof e.z === "number" ? e.z : 0)))).toBe(road.z as number);
    const cards = view.elements.filter((e) => e.kind === "sticky").sort((a, b) => (a.x as number) - (b.x as number));
    const pills = view.elements.filter((e) => e.kind === "shape").sort((a, b) => (a.x as number) - (b.x as number));
    expect((cards[0].y as number) < (pills[0].y as number)).toBe(true);
    expect((cards[1].y as number) > (pills[1].y as number)).toBe(true);
    // Nothing overlaps the title.
    const title = elementBox(view.elements.find((e) => e.kind === "text" && e.size === 36)!);
    for (const c of cards) expect(elementBox(c).y).toBeGreaterThan(title.y + title.h);
    // No two cards overlap.
    for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
      const a = elementBox(cards[i]), b = elementBox(cards[j]);
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
  });

  test("connect chains and refuses unknown keys", () => {
    const v = board([el("a", "sticky", { x: 0, y: 0 }), el("b", "sticky", { x: 300, y: 0 }), el("c", "sticky", { x: 600, y: 0 })]);
    const { res } = run(v, "connect", ["a", "b", "c", "--curved", "--label", "then"]);
    expect(res.ops.map((o: ArtifactOp) => ("put" in o ? [o.put.from, o.put.to, o.put.curve, o.put.label] : null))).toEqual([
      ["a", "b", "curved", "then"],
      ["b", "c", "curved", "then"],
    ]);
    expect(() => run(v, "connect", ["a", "zz"])).toThrow(/no element zz/);
  });

  test("themes frames each group and moves members inside", () => {
    const v = board(["a", "b", "c", "d"].map((k, i) => el(k, "sticky", { x: i * 500, y: i * 300, w: 200, h: 160 })));
    expect(parseThemes("Pricing: a, b\nRisks: c d")).toEqual([{ title: "Pricing", keys: ["a", "b"] }, { title: "Risks", keys: ["c", "d"] }]);
    const { view } = run(v, "themes", [], "Pricing: a b\nRisks: c d");
    const frames = view.elements.filter((e) => e.kind === "frame");
    expect(frames.map((f) => f.title)).toEqual(expect.arrayContaining(["Pricing", "Risks"]));
    const pricing = elementBox(frames.find((f) => f.title === "Pricing")!);
    const risks = elementBox(frames.find((f) => f.title === "Risks")!);
    expect(pricing.x + pricing.w).toBeLessThan(risks.x);
    for (const k of ["a", "b"]) {
      const b = elementBox(view.get(k)!);
      expect(b.x >= pricing.x && b.x + b.w <= pricing.x + pricing.w).toBe(true);
    }
    expect(() => run(v, "themes", [], "X: a nope")).toThrow(/nope/);
  });

  test("card --replace keeps the key so arrows stay attached", () => {
    const v = board([el("a", "sticky", { x: 40, y: 50, text: "Ship it", z: 2 }), el("b", "sticky", { x: 400, y: 50 }), el("c", "connector", { from: "a", to: "b" })]);
    const { view } = run(v, "card", ["ct-4102", "--replace", "a"]);
    expect(view.get("a")).toMatchObject({ kind: "card", ref: "ct-4102", x: 40, y: 50, z: 2 });
    expect(view.get("c")!.from).toBe("a");
  });

  test("arrange, align, move, group, order", () => {
    const v = board([el("a", "sticky", { x: 10, y: 0 }), el("b", "sticky", { x: 500, y: 30 }), el("c", "sticky", { x: 0, y: 400 })]);
    expect(run(v, "arrange", ["row", "a", "b", "c", "--gap", "20"]).view.elements.map((e) => [e.key, e.x, e.y])).toEqual([["a", 0, 0], ["b", 220, 0], ["c", 440, 0]]);
    expect(run(v, "align", ["left", "a", "b"]).view.get("b")!.x).toBe(10);
    expect(run(v, "move", ["a", "b", "--by", "5,-5"]).view.get("b")).toMatchObject({ x: 505, y: 25 });
    const grouped = run(v, "group", ["a", "b"]).view;
    expect(grouped.get("a")!.group).toBe(grouped.get("b")!.group);
    expect(run(grouped, "group", ["a", "--off"]).view.get("a")!.group).toBeUndefined();
    expect(run(v, "order", ["front", "c"]).view.get("c")!.z).toBe(0);
  });
});

describe("describe", () => {
  test("lists frames first with members, then reading order, connectors with their ends", () => {
    const v = board([
      el("el_s2", "sticky", { x: 300, y: 50, text: "Two\nlines", color: "pink" }),
      el("el_s1", "sticky", { x: 40, y: 60, text: "One", icon: "🫐" }),
      el("el_f", "frame", { x: 0, y: 0, w: 600, h: 300, title: "Week 1" }),
      el("el_c", "connector", { from: "el_s1", to: "el_s2", curve: "curved" }),
      el("el_k", "card", { x: 0, y: 400, ref: "ct-12" }),
    ]);
    const text = boardSpec.describe(v);
    const lines = text.split("\n");
    expect(lines[0]).toContain('board "Launch" · 5 elements');
    expect(lines[1]).toBe('el_f  frame  "Week 1"  0,0 600x300  holds el_s1 el_s2');
    expect(lines[2]).toBe('el_s1  sticky  yellow  40,60 200x160  🫐  "One"');
    expect(lines[3]).toBe('el_s2  sticky  pink  300,50 200x160  "Two ⏎ lines"');
    expect(lines[4]).toBe("el_k  card  ct-12  0,400 320x168");
    expect(lines[5]).toBe("el_c  connector  el_s1 → el_s2  curved");
  });
  test("empty board", () => {
    expect(boardSpec.describe(board([]))).toContain("empty");
  });
  test("presence lands on the last written element", () => {
    const v = board([el("a", "sticky", { x: 0, y: 0, w: 200, h: 160 })]);
    expect(boardSpec.presenceFor!(v, ["a"])).toEqual({ point: { x: 200, y: 160 } });
  });
});

describe("clone", () => {
  test("copies get fresh keys and groups, connectors follow both ends or stay on existing ones", async () => {
    const { cloneOps } = await import("./board");
    const els = [
      el("a", "sticky", { x: 0, y: 0, group: "g1", z: 1 }),
      el("b", "sticky", { x: 300, y: 0, group: "g1", z: 2 }),
      el("ab", "connector", { from: "a", to: "b", z: 3 }),
      el("ax", "connector", { from: "a", to: "x", z: 4 }),
      el("ag", "connector", { from: "a", to: "gone", z: 5 }),
    ];
    const { ops } = cloneOps(els, 24, 24, 10, (k) => k === "x");
    expect(ops).toHaveLength(4);
    const puts = ops.map((o: any) => o.put);
    expect(puts[0]).toMatchObject({ kind: "sticky", x: 24, y: 24, z: 10 });
    expect(puts[0].group).not.toBe("g1");
    expect(puts[0].group).toBe(puts[1].group);
    expect(puts[2].from).toBe(ops[0].k);
    expect(puts[2].to).toBe(ops[1].k);
    expect(puts[3].to).toBe("x");
  });
});

describe("review fixes", () => {
  test("straight arrowheads point along the line", () => {
    const g = connectorGeometry(el("c", "connector", { x1: 0, y1: 0, x2: 0, y2: 100 }), () => undefined)!;
    expect(g.angleEnd).toBeCloseTo(Math.PI / 2, 6);
    expect(g.angleStart).toBeCloseTo(-Math.PI / 2, 6);
  });
  test("long text items get their wrapped height", () => {
    const it = parseItem(`text ${"word ".repeat(40)}`)!;
    expect(it.w).toBe(560);
    expect(it.h).toBeGreaterThan(26);
  });
  test("rotated bounds cover the turned box", async () => {
    const { elementBounds } = await import("./board");
    const b = elementBounds(el("r", "shape", { x: 0, y: 0, w: 200, h: 40, rot: 90 }));
    expect(b.w).toBeCloseTo(40, 6);
    expect(b.h).toBeCloseTo(200, 6);
  });
  test("arrange refuses a connector-only selection", () => {
    const v = board([el("a", "sticky", { x: 0, y: 0 }), el("b", "sticky", { x: 300, y: 0 }), el("c", "connector", { from: "a", to: "b" })]);
    expect(() => run(v, "arrange", ["row", "c"])).toThrow(/connectors follow/);
  });
});

describe("clearOffset", () => {
  test("no move when clear, nearest clear spot when not", async () => {
    const { clearOffset } = await import("./board");
    expect(clearOffset({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 500, y: 500, w: 10, h: 10 }])).toEqual({ x: 0, y: 0 });
    const o = clearOffset({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 0, y: 0, w: 100, h: 100 }]);
    const moved = { x: o.x, y: o.y, w: 100, h: 100 };
    expect(moved.x >= 124 || moved.y >= 124 || moved.x <= -124 || moved.y <= -124).toBe(true);
  });
});

describe("elbow connectors", () => {
  const box = (key: string, x: number, y: number, w = 100, h = 60) => ({ key, kind: "shape", rev: 1, x, y, w, h }) as any;
  const axisAligned = (pts: { x: number; y: number }[]) => pts.every((p, i) => i === 0 || Math.abs(p.x - pts[i - 1].x) < 0.01 || Math.abs(p.y - pts[i - 1].y) < 0.01);
  test("side by side boxes join with a straight run", () => {
    const a = box("a", 0, 0), b = box("b", 300, 0);
    const g = connectorGeometry({ key: "c", kind: "connector", rev: 1, from: "a", to: "b", curve: "elbow" } as any, (k) => ({ a, b } as any)[k])!;
    expect(g.points!.length).toBe(2);
    expect(g.points![0].x).toBeCloseTo(104);
    expect(g.points![1].x).toBeCloseTo(296);
  });
  test("offset boxes route with right angles only", () => {
    const a = box("a", 0, 0), b = box("b", 300, 200);
    const g = connectorGeometry({ key: "c", kind: "connector", rev: 1, from: "a", to: "b", curve: "elbow" } as any, (k) => ({ a, b } as any)[k])!;
    expect(axisAligned(g.points!)).toBe(true);
    expect(g.points!.length).toBeGreaterThan(2);
  });
  test("goes around a box in the way", () => {
    const a = box("a", 0, 0), b = box("b", 400, 0), wall = box("w", 180, -40, 60, 140);
    const lookup = (k: string) => ({ a, b } as any)[k];
    const obstacles = [a, b, wall].map((e) => elementBox(e));
    const g = connectorGeometry({ key: "c", kind: "connector", rev: 1, from: "a", to: "b", curve: "elbow" } as any, lookup, obstacles)!;
    const wb = elementBox(wall);
    const crosses = g.points!.some((p, i) => {
      if (i === 0) return false;
      const q = g.points![i - 1];
      return Math.min(p.x, q.x) < wb.x + wb.w && Math.max(p.x, q.x) > wb.x && Math.min(p.y, q.y) < wb.y + wb.h && Math.max(p.y, q.y) > wb.y;
    });
    expect(crosses).toBe(false);
    expect(axisAligned(g.points!)).toBe(true);
  });
  test("label_at moves the label along the route", () => {
    const a = box("a", 0, 0), b = box("b", 300, 0);
    const c = { key: "c", kind: "connector", rev: 1, from: "a", to: "b", curve: "elbow", label_at: 0.25 } as any;
    const g = connectorGeometry(c, (k) => ({ a, b } as any)[k])!;
    expect(g.mid.x).toBeCloseTo(104 + 192 * 0.25);
  });
});

describe("illustrations in item lines", () => {
  test(":name: gives a sticky a painted illustration; unknown names stay text", () => {
    expect(parseItem("sticky:blue :rocket: Launch")!.fields).toMatchObject({ icon: "rocket", text: "Launch", color: "blue" });
    expect(parseItem(":unicorn: Launch")!.fields).toMatchObject({ text: ":unicorn: Launch" });
    expect(parseItem("🫐 Lock flavor")!.fields).toMatchObject({ icon: "🫐", text: "Lock flavor" });
  });
  test("timeline stops take an illustration name with or without colons", () => {
    const [a, b] = parseTimeline("Day 1 | Lock | Body | berries | green\nDay 2 | Ship | | :truck:");
    expect(a.icon).toBe("berries");
    expect(b.icon).toBe("truck");
  });
});

describe("templates", () => {
  for (const name of BOARD_TEMPLATES) {
    test(`${name} lays out elements with fresh keys and no overlapping stickies`, () => {
      const view = artifactView("board", "B", []);
      const r = BOARD_VERBS.template.run(view, [name], undefined) as any;
      const puts = r.ops.filter((o: any) => o.put);
      expect(puts.length).toBeGreaterThan(4);
      expect(new Set(puts.map((o: any) => o.k)).size).toBe(puts.length);
      const stickies = puts.filter((o: any) => o.put.kind === "sticky").map((o: any) => elementBox({ key: o.k, rev: 0, ...o.put }));
      for (let i = 0; i < stickies.length; i++) for (let j = i + 1; j < stickies.length; j++) {
        const a = stickies[i], b = stickies[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    });
  }
  test("an unknown template names the choices", () => {
    expect(() => BOARD_VERBS.template.run(artifactView("board", "B", []), ["mindmap"], undefined)).toThrow(/retro/);
  });
});

describe("agent layout verbs", () => {
  test("size variants and a long sticky grows instead of overflowing", () => {
    const it = parseItem("sticky:w240:h100 " + "word ".repeat(40))!;
    expect(it.w).toBe(240);
    expect(it.h).toBeGreaterThan(100);
  });
  test("matrix: uniform columns, rows as tall as their tallest cell, one band per row", () => {
    const { view: v } = run(board([]), "matrix", ["--cols", "A,B,C", "--cell", "200x120"], "Doing :: Short :: " + "long ".repeat(50) + " :: -\nFeeling :: x :: y :: z");
    const stickies = v.elements.filter((e) => e.kind === "sticky");
    expect(stickies.length).toBe(5);
    const frames = v.elements.filter((e) => e.kind === "frame");
    expect([...frames].sort((a, b) => Number(a.y) - Number(b.y)).map((f) => f.title)).toEqual(["Doing", "Feeling"]);
    const short = stickies.find((s) => s.text === "Short")!;
    const doing = stickies.filter((s) => s.y === short.y);
    expect(doing.length).toBe(2);
    expect(new Set(doing.map((s) => s.h)).size).toBe(1);
    expect(Number(doing[0].h)).toBeGreaterThan(120);
    expect(new Set(stickies.map((s) => s.w))).toEqual(new Set([200]));
    expect(v.elements.filter((e) => e.kind === "shape").map((e) => e.text).sort()).toEqual(["A", "B", "C"]);
  });
  test("edit keeps the key and grows the sticky", () => {
    const s = el("s1", "sticky", { x: 0, y: 0, w: 200, h: 160, text: "a" });
    const { view: v } = run(board([s]), "edit", ["s1", "Title", "|", "word ".repeat(60)]);
    const e = v.get("s1")!;
    expect(String(e.text).startsWith("Title\n")).toBe(true);
    expect(Number(e.h)).toBeGreaterThan(160);
  });
  test("read flags an overflowing sticky; clear empties the board", () => {
    const s = el("s1", "sticky", { x: 0, y: 0, w: 200, h: 120, text: "word ".repeat(80) });
    expect(boardSpec.describe(board([s]))).toContain("OVERFLOWS");
    expect(run(board([s]), "clear", []).view.elements.length).toBe(0);
  });
});

describe("item line edge cases", () => {
  test("stamps take a size, unknown kinds with variants fail loudly, big titles stay on one line", () => {
    expect(parseItem("stamp:w24 🔴")!.fields.size).toBe(24);
    expect(() => parseItem("circle:red Vote")).toThrow(/unknown kind/);
    expect(parseItem("Ship: it")!.fields.text).toBe("Ship: it");
    const t = parseItem("text:44 Q4 Retro · Product team")!;
    expect(t.h).toBeLessThan(44 * 1.3 * 1.5);
  });
});

describe("elbow attachment", () => {
  const box = (key: string, x: number, y: number, w = 100, h = 60) => ({ key, kind: "shape", rev: 1, x, y, w, h }) as any;
  test("arrows from two boxes above a wide box land apart and drop straight", () => {
    const a = box("a", 0, 0), b = box("b", 600, 0), gw = box("g", 0, 200, 1000, 60);
    const lookup = (k: string) => ({ a, b, g: gw } as any)[k];
    const ga = connectorGeometry({ key: "c1", kind: "connector", rev: 1, from: "a", to: "g", curve: "elbow" } as any, lookup)!;
    const gb = connectorGeometry({ key: "c2", kind: "connector", rev: 1, from: "b", to: "g", curve: "elbow" } as any, lookup)!;
    expect(Math.abs(ga.b.x - gb.b.x)).toBeGreaterThan(400);
    expect(ga.points!.length).toBe(2);
  });
  test("a pinned end stays where it is pinned", () => {
    const a = box("a", 0, 0), g = box("g", 0, 200, 1000, 60);
    const c = { key: "c", kind: "connector", rev: 1, from: "a", to: "g", curve: "elbow", to_at: [0.9, 0] } as any;
    const geo = connectorGeometry(c, (k) => ({ a, g } as any)[k])!;
    expect(Math.round(geo.b.x)).toBe(Math.round(-4 + 0.9 * 1008));
  });
});
