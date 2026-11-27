import { describe, expect, test } from "bun:test";
import { artifactView, type ArtifactView } from "./spec";
import { foldOps, toElement, type ArtifactElement, type ArtifactOp, type ElementState } from "./core";
import {
  carriedKeys,
  cloneOps,
  collapseFrameOps,
  describeBoard,
  elementBox,
  enclosingFrameKeys,
  expandFrameOps,
  FRAME_GAP,
  FRAME_PAD,
  FRAME_PILL_H,
  FRAME_SPACING,
  FRAME_TITLE_BAND,
  hiddenKeys,
  moveFrameOps,
  organizeOps,
  reflowFrameOps,
  type Box,
} from "./board";

function el(key: string, kind: string, fields: Record<string, any>): ArtifactElement {
  return { key, kind, rev: 1, ...fields } as ArtifactElement;
}
const sticky = (key: string, x: number, y: number, extra: Record<string, any> = {}) => el(key, "sticky", { x, y, w: 200, h: 160, text: key, color: "yellow", ...extra });
const frame = (key: string, x: number, y: number, w: number, h: number, extra: Record<string, any> = {}) => el(key, "frame", { x, y, w, h, title: key, ...extra });

function board(els: ArtifactElement[]) {
  return artifactView("board", "Huddle", els);
}

/** Apply one batch the way live.apply does and return the next view. */
function apply(view: ArtifactView, ops: ArtifactOp[]): ArtifactView {
  const state = new Map<string, ElementState>();
  for (const e of view.elements) state.set(e.key, { kind: e.kind, fields: Object.fromEntries(Object.entries(e).filter(([f]) => !["key", "kind", "rev", "by", "at"].includes(f))) as any });
  foldOps(state, ops);
  return board([...state].filter(([, s]) => !s.deleted).map(([k, s]) => toElement(k, s)));
}

const box = (v: ArtifactView, k: string): Box => elementBox(v.get(k)!);
const pos = (v: ArtifactView, k: string) => ({ x: v.get(k)!.x, y: v.get(k)!.y });
const overlaps = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
const inside = (o: Box, i: Box) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;

/** A theme frame with two stickies and an arrow between them, a sticky outside it with an arrow in, and a frame below. */
function themeBoard() {
  return board([
    frame("el_f", 0, 0, 600, 400, { ref: "pri-3", status: "open" }),
    sticky("el_a", 40, 64),
    sticky("el_b", 300, 64),
    el("el_ab", "connector", { from: "el_a", to: "el_b" }),
    sticky("el_out", 800, 64),
    el("el_in", "connector", { from: "el_out", to: "el_a" }),
    frame("el_g", 0, 500, 600, 300),
    sticky("el_g1", 40, 564),
  ]);
}

describe("collapse and expand", () => {
  test("collapse folds the frame into a pill at its top-left and holds its contents", () => {
    const v0 = themeBoard();
    const v1 = apply(v0, collapseFrameOps(v0, "el_f"));
    const f = v1.get("el_f")!;
    expect(f.collapsed).toEqual({ w: 600, h: 400, holds: expect.arrayContaining(["el_a", "el_b", "el_ab"]) });
    expect((f.collapsed as any).holds).toHaveLength(3);
    expect({ x: f.x, y: f.y, h: f.h }).toEqual({ x: 0, y: 0, h: FRAME_PILL_H });
    expect(f.w as number).toBeGreaterThanOrEqual(260);
    // The arrow from outside keeps an end outside, so it stays visible.
    expect([...hiddenKeys(v1)].sort()).toEqual(["el_a", "el_ab", "el_b"]);
    // Shrinking moves no neighbour.
    expect(pos(v1, "el_g")).toEqual(pos(v0, "el_g"));
    expect(pos(v1, "el_a")).toEqual(pos(v0, "el_a"));
  });

  test("collapse then expand restores every position and size exactly", () => {
    const v0 = themeBoard();
    const v2 = apply(apply(v0, collapseFrameOps(v0, "el_f")), expandFrameOps(apply(v0, collapseFrameOps(v0, "el_f")), "el_f"));
    const fields = ({ rev, by, at, ...rest }: any) => JSON.parse(JSON.stringify(rest));
    for (const e of v0.elements) expect(fields(v2.get(e.key))).toEqual(fields(e));
    expect(hiddenKeys(v2).size).toBe(0);
  });

  test("a collapsed pill that moves carries what it holds, and opens around it", () => {
    const v0 = themeBoard();
    const v1 = apply(v0, collapseFrameOps(v0, "el_f"));
    const v2 = apply(v1, moveFrameOps(v1, "el_f", 1000, 2000));
    expect(pos(v2, "el_a")).toEqual({ x: 1040, y: 2064 });
    expect(pos(v2, "el_b")).toEqual({ x: 1300, y: 2064 });
    expect(pos(v2, "el_out")).toEqual(pos(v0, "el_out"));
    const v3 = apply(v2, expandFrameOps(v2, "el_f"));
    expect(box(v3, "el_f")).toEqual({ x: 1000, y: 2000, w: 600, h: 400 });
    expect(inside(box(v3, "el_f"), box(v3, "el_a"))).toBe(true);
    expect(inside(box(v3, "el_f"), box(v3, "el_b"))).toBe(true);
  });

  test("expand pulls back contents left behind by a pill moved without them", () => {
    const v0 = themeBoard();
    const v1 = apply(v0, collapseFrameOps(v0, "el_f"));
    const v2 = apply(v1, [{ k: "el_f", set: { x: 3000, y: 3000 } }]);
    const v3 = apply(v2, expandFrameOps(v2, "el_f"));
    const f = box(v3, "el_f");
    expect(inside(f, box(v3, "el_a"))).toBe(true);
    expect(inside(f, box(v3, "el_b"))).toBe(true);
    expect(box(v3, "el_a").x - box(v3, "el_b").x).toBe(40 - 300);
  });

  test("a frame parked wholly inside the folded area is pushed out on expand, with its contents", () => {
    const v0 = themeBoard();
    const v1 = apply(v0, collapseFrameOps(v0, "el_f"));
    const v2 = apply(v1, moveFrameOps(v1, "el_g", 0, 100 - 500));
    const v3 = apply(v2, expandFrameOps(v2, "el_f"));
    expect(box(v3, "el_g").y).toBe(400 + FRAME_SPACING);
    expect(box(v3, "el_g1").y).toBe(400 + FRAME_SPACING + 64);
    expect(pos(v3, "el_out")).toEqual(pos(v0, "el_out"));
  });

  test("collapse then expand leaves a sibling that already overlapped the frame where it was", () => {
    const v0 = board([frame("el_A", 0, 0, 600, 400), sticky("el_a", 40, 64), frame("el_B", 0, 300, 600, 300)]);
    const v1 = apply(v0, collapseFrameOps(v0, "el_A"));
    expect(box(v1, "el_B").y).toBe(300);
    const v2 = apply(v1, expandFrameOps(v1, "el_A"));
    expect(box(v2, "el_B").y).toBe(300);
    expect(box(v2, "el_A")).toEqual(box(v0, "el_A"));
  });

  test("expanding over a loose sticky after the pill moved pushes it out, and it stays out", () => {
    const v0 = board([frame("el_A", 0, 0, 600, 400), sticky("el_a", 40, 64), frame("el_B", 0, 300, 600, 300), sticky("el_P", 1240, 200)]);
    const v1 = apply(v0, collapseFrameOps(v0, "el_A"));
    const v2 = apply(v1, moveFrameOps(v1, "el_A", 1000, 0));
    const v3 = apply(v2, expandFrameOps(v2, "el_A"));
    const v4 = apply(v3, reflowFrameOps(v3, "el_A"));
    for (const v of [v3, v4]) {
      expect(overlaps(box(v, "el_A"), box(v, "el_P"))).toBe(false);
      expect(box(v, "el_P").y).toBeGreaterThanOrEqual(box(v, "el_A").y + box(v, "el_A").h);
      expect(box(v, "el_B").y).toBe(300);
    }
  });

  test("a sticky placed inside a folded frame's area is pushed out on expand, not taken in", () => {
    const v0 = board([frame("el_A", 0, 0, 600, 400), sticky("el_a", 40, 64), frame("el_B", 0, 300, 600, 300)]);
    const v1 = apply(v0, collapseFrameOps(v0, "el_A"));
    const v2 = apply(v1, [{ k: "el_Q", put: { kind: "sticky", x: 300, y: 200, w: 200, h: 160, text: "Q", color: "yellow" } }]);
    const v3 = apply(v2, expandFrameOps(v2, "el_A"));
    const v4 = apply(v3, reflowFrameOps(v3, "el_A"));
    for (const v of [v3, v4]) {
      expect(overlaps(box(v, "el_A"), box(v, "el_Q"))).toBe(false);
      expect(box(v, "el_Q").y).toBeGreaterThanOrEqual(box(v, "el_A").y + box(v, "el_A").h);
      expect(box(v, "el_B").y).toBe(300);
    }
    expect(pos(v4, "el_a")).toEqual(pos(v0, "el_a"));
  });

  test("an arrow from inside a nested fold to a sibling hides when the outer frame folds", () => {
    const v0 = board([
      frame("el_o", 0, 0, 1000, 800),
      frame("el_i", 40, 64, 500, 400),
      sticky("el_x", 80, 128),
      sticky("el_s", 700, 128),
      el("el_xs", "connector", { from: "el_x", to: "el_s" }),
    ]);
    const v1 = apply(v0, collapseFrameOps(v0, "el_i"));
    expect(hiddenKeys(v1).has("el_xs")).toBe(false);
    const v2 = apply(v1, collapseFrameOps(v1, "el_o"));
    expect([...hiddenKeys(v2)].sort()).toEqual(["el_i", "el_s", "el_x", "el_xs"]);
    expect((v2.get("el_o")!.collapsed as any).holds).toContain("el_xs");
  });

  test("nested: folding the inner frame reflows the outer; folding the outer hides both", () => {
    const v0 = board([
      frame("el_o", 0, 0, 1000, 800),
      frame("el_i", 40, 64, 500, 400),
      sticky("el_s1", 80, 128),
      sticky("el_s2", 700, 128),
    ]);
    const v1 = apply(v0, collapseFrameOps(v0, "el_i"));
    expect([...hiddenKeys(v1)]).toEqual(["el_s1"]);
    // The outer frame reflowed: pill then s2 in one row, and it shrank to fit.
    const o1 = box(v1, "el_o"), i1 = box(v1, "el_i");
    expect(i1).toMatchObject({ x: FRAME_PAD, y: FRAME_PAD + FRAME_TITLE_BAND, h: FRAME_PILL_H });
    expect(pos(v1, "el_s2")).toEqual({ x: FRAME_PAD + i1.w + FRAME_GAP, y: FRAME_PAD + FRAME_TITLE_BAND });
    expect(o1.h).toBe(FRAME_PAD + FRAME_TITLE_BAND + 160 + FRAME_PAD);
    // The hidden sticky moved with the pill.
    expect(pos(v1, "el_s1")).toEqual({ x: 80, y: 128 });

    const v2 = apply(v1, collapseFrameOps(v1, "el_o"));
    expect([...hiddenKeys(v2)].sort()).toEqual(["el_i", "el_s1", "el_s2"]);
    expect((v2.get("el_o")!.collapsed as any).holds.sort()).toEqual(["el_i", "el_s2"]);

    const v3 = apply(v2, expandFrameOps(v2, "el_o"));
    expect([...hiddenKeys(v3)]).toEqual(["el_s1"]);
    expect(box(v3, "el_o")).toEqual(o1);
    const v4 = apply(v3, expandFrameOps(v3, "el_i"));
    expect(hiddenKeys(v4).size).toBe(0);
    expect(inside(box(v4, "el_i"), box(v4, "el_s1"))).toBe(true);
    expect(inside(box(v4, "el_o"), box(v4, "el_i"))).toBe(true);
    expect(overlaps(box(v4, "el_i"), box(v4, "el_s2"))).toBe(false);
  });

  test("reflowParent: false folds and unfolds the inner frame and leaves the outer one and its stickies as they were", () => {
    const v0 = board([
      frame("el_o", 0, 0, 1000, 800),
      frame("el_i", 40, 64, 500, 400),
      sticky("el_s1", 80, 128),
      sticky("el_s2", 700, 128),
    ]);
    expect(enclosingFrameKeys(v0, "el_i")).toEqual(["el_o"]);
    expect(enclosingFrameKeys(v0, "el_s1")).toEqual(["el_i", "el_o"]);
    expect(enclosingFrameKeys(v0, "el_o")).toEqual([]);
    const ops = collapseFrameOps(v0, "el_i", { reflowParent: false });
    expect(ops.map((o) => o.k)).toEqual(["el_i"]);
    const v1 = apply(v0, ops);
    expect([...hiddenKeys(v1)]).toEqual(["el_s1"]);
    expect(box(v1, "el_i")).toMatchObject({ x: 40, y: 64, h: FRAME_PILL_H });
    expect(box(v1, "el_o")).toEqual(box(v0, "el_o"));
    expect(pos(v1, "el_s2")).toEqual({ x: 700, y: 128 });

    const v2 = apply(v1, expandFrameOps(v1, "el_i", { reflowParent: false }));
    expect(hiddenKeys(v2).size).toBe(0);
    for (const k of ["el_o", "el_i", "el_s1", "el_s2"]) expect(box(v2, k)).toEqual(box(v0, k));
  });

  test("refuses frames in the wrong state", () => {
    const v0 = themeBoard();
    expect(() => expandFrameOps(v0, "el_f")).toThrow(/not collapsed/);
    expect(() => collapseFrameOps(v0, "el_a")).toThrow(/not a visible frame/);
    const v1 = apply(v0, collapseFrameOps(v0, "el_f"));
    expect(() => collapseFrameOps(v1, "el_f")).toThrow(/is collapsed/);
    expect(() => reflowFrameOps(v1, "el_a")).toThrow(/not a visible frame/);
  });
});

describe("reflow", () => {
  test("text rows first, then a wrapping row flow in reading order, and the frame sizes to fit", () => {
    const v0 = board([
      frame("el_f", 0, 0, 600, 1200),
      sticky("el_c", 50, 700),
      sticky("el_a", 50, 300),
      sticky("el_b", 350, 310),
      el("el_t", "text", { x: 100, y: 900, w: 300, h: 32, text: "To summarize", size: 20 }),
      el("el_stamp", "stamp", { x: 120, y: 360, emoji: "👍" }),
    ]);
    const v1 = apply(v0, reflowFrameOps(v0, "el_f"));
    const top = FRAME_PAD + FRAME_TITLE_BAND;
    expect(pos(v1, "el_t")).toEqual({ x: FRAME_PAD, y: top });
    const row = top + 32 + FRAME_GAP;
    expect(pos(v1, "el_a")).toEqual({ x: FRAME_PAD, y: row });
    expect(pos(v1, "el_b")).toEqual({ x: FRAME_PAD + 200 + FRAME_GAP, y: row });
    expect(pos(v1, "el_c")).toEqual({ x: FRAME_PAD, y: row + 160 + FRAME_GAP });
    // The stamp rides its sticky.
    expect(pos(v1, "el_stamp")).toEqual({ x: 120 - 50 + FRAME_PAD, y: 360 - 300 + row });
    expect(box(v1, "el_f")).toEqual({ x: 0, y: 0, w: 600, h: row + 160 + FRAME_GAP + 160 + FRAME_PAD });
  });

  test("a frame too narrow for a child widens to hold it", () => {
    const v0 = board([frame("el_f", 0, 0, 500, 300), sticky("el_a", 10, 10, { w: 450 })]);
    const v1 = apply(v0, reflowFrameOps(v0, "el_f"));
    expect(box(v1, "el_f").w).toBe(450 + FRAME_PAD * 2);
  });

  test("a nested frame moves as one unit with its contents and arrows' free ends", () => {
    const v0 = board([
      frame("el_o", 0, 0, 1400, 1000),
      frame("el_i", 600, 400, 500, 300),
      sticky("el_s", 640, 464),
      el("el_line", "connector", { x1: 650, y1: 450, x2: 1000, y2: 650 }),
    ]);
    const v1 = apply(v0, reflowFrameOps(v0, "el_o"));
    const dx = FRAME_PAD - 600, dy = FRAME_PAD + FRAME_TITLE_BAND - 400;
    expect(pos(v1, "el_i")).toEqual({ x: 600 + dx, y: 400 + dy });
    expect(pos(v1, "el_s")).toEqual({ x: 640 + dx, y: 464 + dy });
    expect(v1.get("el_line")).toMatchObject({ x1: 650 + dx, y1: 450 + dy, x2: 1000 + dx, y2: 650 + dy });
  });

  test("growing pushes what it newly overlaps down, cascading, loose elements included", () => {
    const v0 = board([
      frame("el_a", 0, 0, 600, 300),
      ...[0, 1, 2, 3, 4, 5].map((i) => sticky(`el_a${i}`, 40 + (i % 2) * 260, 64 + Math.floor(i / 2) * 10)),
      frame("el_b", 0, 400, 600, 300),
      sticky("el_b1", 40, 464),
      frame("el_c", 0, 800, 600, 300),
      frame("el_far", 2000, 0, 600, 300),
      sticky("el_loose", 0, 1200),
    ]);
    const v1 = apply(v0, reflowFrameOps(v0, "el_a"));
    const a = box(v1, "el_a");
    expect(a.h).toBeGreaterThan(400);
    const b = box(v1, "el_b"), c = box(v1, "el_c");
    expect(b.y).toBe(a.y + a.h + FRAME_SPACING);
    expect(c.y).toBe(b.y + b.h + FRAME_SPACING);
    expect(pos(v1, "el_b1")).toEqual({ x: 40, y: b.y + 64 });
    expect(pos(v1, "el_far")).toEqual(pos(v0, "el_far"));
    // C now reaches the loose sticky, so it moves down clear of C too.
    expect(pos(v1, "el_loose")).toEqual({ x: 0, y: c.y + c.h + FRAME_GAP });
  });

  test("a growing frame never swallows a loose sticky, even over two reflows", () => {
    const v0 = board([frame("el_F", 0, 0, 500, 260), sticky("el_1", 40, 64), sticky("el_2", 260, 64), sticky("el_P", 40, 280)]);
    const v1 = apply(v0, reflowFrameOps(v0, "el_F"));
    const v2 = apply(v1, reflowFrameOps(v1, "el_F"));
    for (const v of [v1, v2]) {
      const f = box(v, "el_F"), p = box(v, "el_P");
      expect(overlaps(f, p)).toBe(false);
      expect(p.y).toBeGreaterThanOrEqual(f.y + f.h);
    }
    expect(box(v1, "el_F").h).toBeGreaterThan(260);
  });

  test("reflowing a frame already laid out writes nothing", () => {
    const v0 = board([
      frame("el_f", 0, 0, 600, 1200),
      sticky("el_a", 50, 300),
      sticky("el_b", 350, 310, { h: 400 }),
      sticky("el_c", 50, 700),
      el("el_t", "text", { x: 100, y: 900, w: 300, h: 32, text: "To summarize", size: 20 }),
    ]);
    const v1 = apply(v0, reflowFrameOps(v0, "el_f"));
    expect(reflowFrameOps(v1, "el_f")).toEqual([]);
  });

  test("shrinking leaves neighbours where they are", () => {
    const v0 = board([frame("el_a", 0, 0, 600, 1200), sticky("el_a1", 40, 600), frame("el_b", 0, 1300, 600, 300)]);
    const v1 = apply(v0, reflowFrameOps(v0, "el_a"));
    expect(box(v1, "el_a").h).toBe(FRAME_PAD + FRAME_TITLE_BAND + 160 + FRAME_PAD);
    expect(pos(v1, "el_b")).toEqual(pos(v0, "el_b"));
  });

  test("a frame that grows past its enclosing frame does not adopt the siblings it covers", () => {
    const v0 = board([
      frame("el_o", 0, 0, 1200, 600),
      frame("el_i", 40, 64, 400, 250),
      ...[0, 1, 2].map((i) => sticky(`el_i${i}`, 60 + i * 20, 80)),
      sticky("el_sib", 40, 340),
    ]);
    const v1 = apply(v0, reflowFrameOps(v0, "el_i"));
    const o = box(v1, "el_o"), i = box(v1, "el_i"), sib = box(v1, "el_sib");
    expect(inside(o, i)).toBe(true);
    expect(inside(o, sib)).toBe(true);
    expect(overlaps(i, sib)).toBe(false);
  });

  test("ops are one batch with one op per element", () => {
    const v0 = themeBoard();
    const ops = collapseFrameOps(v0, "el_f");
    expect(new Set(ops.map((o) => o.k)).size).toBe(ops.length);
  });
});

describe("carriedKeys and moveFrameOps", () => {
  test("a frame carries nested frames, held keys and arrows inside it, not arrows leaving it", () => {
    const v0 = board([
      frame("el_o", 0, 0, 1000, 800),
      frame("el_i", 40, 64, 500, 400, { collapsed: { w: 500, h: 400, holds: ["el_h"] } }),
      sticky("el_h", 2000, 2000),
      sticky("el_s", 600, 100),
      el("el_c1", "connector", { from: "el_s", to: "el_i" }),
      el("el_c2", "connector", { from: "el_s", to: "el_x" }),
      sticky("el_x", 1500, 0),
    ]);
    expect(carriedKeys(v0, ["el_o"]).sort()).toEqual(["el_c1", "el_h", "el_i", "el_o", "el_s"]);
    const ops = moveFrameOps(v0, "el_o", 10, 20);
    expect(ops.find((o) => o.k === "el_h")).toEqual({ k: "el_h", set: { x: 2010, y: 2020 } });
    expect(ops.some((o) => o.k === "el_x" || o.k === "el_c1")).toBe(false);
  });
});

describe("cloneOps", () => {
  test("a copied folded frame holds the copies, not the originals", () => {
    const v0 = themeBoard();
    const v1 = apply(v0, collapseFrameOps(v0, "el_f"));
    const els = carriedKeys(v1, ["el_f"]).map((k) => v1.get(k)!);
    const { ops, map } = cloneOps(els, 0, 1000, 100);
    const copy = ops.find((o) => o.k === map.get("el_f"))! as { put: any };
    expect(copy.put.collapsed.holds.sort()).toEqual(["el_a", "el_ab", "el_b"].map((k) => map.get(k)).sort());
    const v2 = apply(v1, ops);
    expect(hiddenKeys(v2).size).toBe(6);
  });
});

describe("organize", () => {
  test("agenda frames on top, topics below, cards beside their frame, strays gridded under", () => {
    const v0 = board([
      frame("el_t1", 900, 1500, 600, 400, { title: "Budget caps" }),
      sticky("el_t1a", 950, 1600),
      frame("el_ag1", 3000, 2500, 500, 300, { title: "Agenda: Jason" }),
      frame("el_t2", 100, 100, 600, 400, { title: "Hiring" }),
      frame("el_ag2", 0, 3000, 500, 300, { title: "Ashot" }),
      el("el_card", "card", { x: 1600, y: 1550, w: 320, h: 168, ref: "ct-1" }),
      sticky("el_s1", 4000, 4000),
      sticky("el_s2", 4300, 4000),
    ]);
    const v1 = apply(v0, organizeOps(v0, { people: ["Ashot Petrosian"] }));
    const ag1 = box(v1, "el_ag1"), ag2 = box(v1, "el_ag2"), t1 = box(v1, "el_t1"), t2 = box(v1, "el_t2");
    const origin = { x: 0, y: 100 };
    expect(ag1.y).toBe(origin.y);
    expect(ag2.y).toBe(origin.y);
    expect(Math.min(ag1.x, ag2.x)).toBe(origin.x);
    const agendaBottom = Math.max(ag1.y + ag1.h, ag2.y + ag2.h);
    for (const t of [t1, t2]) expect(t.y).toBeGreaterThanOrEqual(agendaBottom + FRAME_SPACING);
    // Topics keep reading order: Hiring (top-left before) comes first.
    expect(t2.x).toBeLessThan(t1.x);
    // The card sits right beside its frame.
    const card = box(v1, "el_card");
    expect(card.x).toBe(t1.x + t1.w + FRAME_PAD);
    expect(card.y).toBe(t1.y);
    // The sticky inside a frame stays inside it; strays go below every frame, in a row.
    expect(inside(t1, box(v1, "el_t1a"))).toBe(true);
    const framesBottom = Math.max(...["el_t1", "el_t2", "el_ag1", "el_ag2"].map((k) => box(v1, k).y + box(v1, k).h));
    const s1 = box(v1, "el_s1"), s2 = box(v1, "el_s2");
    expect(s1.y).toBe(framesBottom + FRAME_SPACING);
    expect(s1.x).toBe(origin.x);
    expect(s2).toMatchObject({ x: origin.x + 200 + FRAME_GAP, y: s1.y });
    // Nothing on top of anything.
    const all = ["el_t1", "el_t2", "el_ag1", "el_ag2", "el_card", "el_s1", "el_s2"].map((k) => box(v1, k));
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j])).toBe(false);
  });

  test("collapsed frames are placed as pills with their holds travelling along", () => {
    const v0 = themeBoard();
    const v1 = apply(v0, collapseFrameOps(v0, "el_f"));
    const v2 = apply(v1, organizeOps(v1));
    const f = v2.get("el_f")!;
    expect(f.h).toBe(FRAME_PILL_H);
    expect({ x: (v2.get("el_a")!.x as number) - (f.x as number), y: (v2.get("el_a")!.y as number) - (f.y as number) }).toEqual({ x: 40, y: 64 });
    expect([...hiddenKeys(v2)].sort()).toEqual(["el_a", "el_ab", "el_b"]);
  });

  test("organizing twice changes nothing the second time", () => {
    const v0 = board([
      frame("el_wide", 500, 900, 1200, 300, { title: "Wide" }),
      sticky("el_w1", 540, 964),
      frame("el_tall", 0, 0, 400, 700, { title: "Tall" }),
      frame("el_small", 2400, 100, 400, 300, { title: "Small" }),
      frame("el_ag", 3000, 3000, 500, 300, { title: "Agenda" }),
      el("el_card", "card", { x: 1800, y: 950, w: 320, h: 168, ref: "ct-1" }),
      sticky("el_s1", 4000, 4000, { h: 400 }),
      sticky("el_s2", 4300, 4100),
      sticky("el_s3", 4600, 4000, { h: 240 }),
      el("el_t", "text", { x: 4000, y: 4600, w: 300, h: 32, text: "loose note", size: 20 }),
    ]);
    const v1 = apply(v0, organizeOps(v0));
    expect(organizeOps(v1)).toEqual([]);
  });

  test("an empty board organizes to nothing", () => {
    expect(organizeOps(board([]))).toEqual([]);
  });
});

describe("describe", () => {
  test("frame lines carry ref, status and collapsed; hidden elements list under their frame", () => {
    const v0 = themeBoard();
    const open = describeBoard(v0);
    expect(open).toContain(`el_f  frame  "el_f"  0,0 600x400  ref pri-3  status open  holds el_a el_b`);
    const v1 = apply(v0, collapseFrameOps(v0, "el_f"));
    const lines = describeBoard(v1).split("\n");
    const at = lines.findIndex((l) => l.startsWith("el_f  frame"));
    // The count is the pill's: two stickies, the arrow between them aside.
    expect(lines[at]).toMatch(/ref pri-3  status open  collapsed \(2\)$/);
    const held = lines.slice(at + 1, at + 4);
    expect(held.every((l) => l.startsWith("  "))).toBe(true);
    expect(held.map((l) => l.trim().split(/\s+/)[0]).sort()).toEqual(["el_a", "el_ab", "el_b"]);
    // Each key appears once; no loose line for a hidden element.
    for (const k of ["el_a", "el_b", "el_ab"]) expect(lines.filter((l) => l.trim().startsWith(`${k} `)).length).toBe(1);
  });

  test("nested folds indent deeper", () => {
    const v0 = board([frame("el_o", 0, 0, 1000, 800), frame("el_i", 40, 64, 500, 400), sticky("el_s1", 80, 128)]);
    const v1 = apply(v0, collapseFrameOps(v0, "el_i"));
    const v2 = apply(v1, collapseFrameOps(v1, "el_o"));
    const lines = describeBoard(v2).split("\n");
    expect(lines.find((l) => l.includes("el_i  frame"))).toMatch(/^ {2}el_i/);
    expect(lines.find((l) => l.includes("el_s1  sticky"))).toMatch(/^ {4}el_s1/);
  });
});
