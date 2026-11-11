// Boards (ct-91884 owns this file): an infinite canvas people and their agent
// sessions sketch on together. Elements are keyed el_<id>; geometry lives in
// boardGeometry.ts, layouts in boardLayout.ts, CLI verbs in boardVerbs.ts.
import type { ArtifactElement } from "./core";
import type { ArtifactSpec, ArtifactView } from "./spec";
import { center, connectorGeometry, contains, elementBox, unionBox, type Box } from "./boardGeometry";
import { BOARD_VERBS } from "./boardVerbs";

export * from "./boardGeometry";
export * from "./boardLayout";
export { BOARD_VERBS, parseVerbArgs } from "./boardVerbs";

export const BOARD_KINDS = ["sticky", "text", "shape", "connector", "frame", "pen", "image", "stamp", "card"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

const fmtBox = (b: Box) => `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}`;

function quote(v: unknown, max = 140): string {
  const s = typeof v === "string" ? v : "";
  const cut = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return JSON.stringify(cut).replace(/\\n/g, " ⏎ ");
}

/** Elements in reading order: frames first, then top-to-bottom bands, left to right. */
export function readingOrder(els: readonly ArtifactElement[]): ArtifactElement[] {
  const boxes = new Map(els.map((e) => [e.key, elementBox(e)]));
  const band = (e: ArtifactElement) => Math.floor(boxes.get(e.key)!.y / 80);
  return [...els].sort((a, b) => {
    const fa = a.kind === "frame" ? 0 : a.kind === "connector" ? 2 : 1;
    const fb = b.kind === "frame" ? 0 : b.kind === "connector" ? 2 : 1;
    if (fa !== fb) return fa - fb;
    return band(a) - band(b) || boxes.get(a.key)!.x - boxes.get(b.key)!.x || (a.key < b.key ? -1 : 1);
  });
}

/** One element as a describe line. */
export function describeElement(el: ArtifactElement, view: Pick<ArtifactView, "get" | "elements">): string {
  const b = elementBox(el);
  const parts: string[] = [el.key, el.kind];
  switch (el.kind) {
    case "sticky":
      parts.push(String(el.color ?? "yellow"), fmtBox(b));
      if (el.icon) parts.push(String(el.icon));
      parts.push(quote(el.text));
      break;
    case "text":
      parts.push(`${el.size ?? 20}px${el.weight === "bold" ? " bold" : ""}`, fmtBox(b), quote(el.text));
      break;
    case "shape":
      parts.push(String(el.shape ?? "rect"), String(el.color ?? "blue"), fmtBox(b));
      if (el.text) parts.push(quote(el.text));
      break;
    case "frame": {
      const holds = view.elements.filter((o) => o.key !== el.key && o.kind !== "frame" && o.kind !== "connector" && contains(b, elementBox(o))).map((o) => o.key);
      parts.push(quote(el.title), fmtBox(b));
      if (holds.length) parts.push(`holds ${holds.join(" ")}`);
      break;
    }
    case "connector": {
      const from = typeof el.from === "string" ? el.from : `(${el.x1},${el.y1})`;
      const to = typeof el.to === "string" ? el.to : `(${el.x2},${el.y2})`;
      parts.push(`${from} → ${to}`);
      if (el.curve === "curved") parts.push("curved");
      if (el.arrow && el.arrow !== "end") parts.push(`arrow=${el.arrow}`);
      if (el.label) parts.push(quote(el.label));
      break;
    }
    case "pen": {
      const n = Array.isArray(el.points) ? el.points.length / 2 : 0;
      parts.push(fmtBox(b), `${n} pts`, String(el.color ?? "gray"), `w${el.width ?? 4}`);
      break;
    }
    case "stamp": {
      parts.push(String(el.emoji ?? "👍"), fmtBox(b));
      const c = center(b);
      const on = view.elements.find((o) => o.key !== el.key && o.kind !== "frame" && o.kind !== "connector" && o.kind !== "stamp" && contains(elementBox(o), { ...c, w: 0, h: 0 }));
      if (on) parts.push(`on ${on.key}`);
      break;
    }
    case "card":
      parts.push(String(el.ref ?? "?"), fmtBox(b));
      break;
    case "image":
      parts.push(fmtBox(b), quote(el.alt ?? el.src, 80));
      break;
    default:
      parts.push(fmtBox(b));
  }
  if (typeof el.rot === "number" && el.rot) parts.push(`rot=${Math.round(el.rot)}`);
  return parts.join("  ");
}

export function describeBoard(view: ArtifactView): string {
  if (view.elements.length === 0) return `board "${view.title}": empty. Start anywhere; 0,0 is a fine top-left.`;
  const content = unionBox(view.elements.filter((e) => e.kind !== "connector").map(elementBox));
  const head = `board "${view.title}" · ${view.elements.length} elements` +
    (content ? ` · content ${Math.round(content.x)},${Math.round(content.y)} → ${Math.round(content.x + content.w)},${Math.round(content.y + content.h)}` : "") +
    " · x right, y down, boxes are x,y wxh";
  const lines = readingOrder(view.elements).map((e) => describeElement(e, view));
  const groups = new Map<string, string[]>();
  for (const e of view.elements) if (typeof e.group === "string") groups.set(e.group, [...(groups.get(e.group) ?? []), e.key]);
  for (const [g, keys] of groups) lines.push(`group ${g}: ${keys.join(" ")}`);
  return [head, ...lines].join("\n");
}

export const boardSpec: ArtifactSpec = {
  type: "board",
  label: "Board",
  cli: "board",
  kinds: BOARD_KINDS,
  describe: describeBoard,
  presenceFor(view, keys) {
    const boxes: Box[] = [];
    for (const k of keys) {
      const el = view.get(k);
      if (!el) continue;
      if (el.kind === "connector") {
        const g = connectorGeometry(el, view.get);
        if (g) boxes.push(g.box);
      } else boxes.push(elementBox(el));
    }
    // The cursor rests at the corner of the last thing written, so a watcher
    // sees it move with the work without covering what it wrote.
    const last = boxes[boxes.length - 1];
    if (!last) return undefined;
    return { point: { x: Math.round(last.x + last.w), y: Math.round(last.y + last.h) } };
  },
  verbs: BOARD_VERBS,
  agentGuide: [
    "Boards: `cast board read <doc>` lists every element (key, kind, box x,y wxh, text). Lay out with the verbs, never hand-computed coordinates.",
    "Without --at, new content goes below what is there. Keep 40px gaps; stickies are 200x160.",
    "Item lines (place, add): `[kind[:variant...]] text`, ` | ` breaks a line; a leading emoji on a sticky is its illustration.",
    "  Lock flavor | Huckleberry it is        sticky:green 🫐 Lock flavor        shape:diamond:blue Ship?        text:36 Heading        card ct-4102        stamp 🎉",
    "Timeline stops: `label | title | body | emoji | color`, e.g. `Day 1 | Lock flavor | Huckleberry it is | 🫐 | yellow`. One call draws the title, road, pills and stemmed cards.",
    "Themes: `Theme name: el_a el_b el_c` per line regroups existing stickies into titled frames.",
    "Colors: yellow orange red pink violet blue cyan green gray. Shapes: rect ellipse diamond pill.",
    "Live codecast objects go on as cards: `cast board card <doc> ct-123`. Stickies into tasks: `cast task create` each, then `cast board card <doc> <ct-id> --replace <sticky key>` (same key, arrows stay attached).",
    "Anything else: `cast board apply <doc>` with raw ops.",
  ].join("\n"),
};
