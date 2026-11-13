// Boards (ct-91884 owns this file): an infinite canvas people and their agent
// sessions sketch on together. Elements are keyed el_<id>; geometry lives in
// boardGeometry.ts, layouts in boardLayout.ts, CLI verbs in boardVerbs.ts.
import type { ArtifactElement } from "./core";
import type { ArtifactSpec, ArtifactView } from "./spec";
import { center, connectorGeometry, contains, elementBox, stickyFitHeight, stickyIconHeight, unionBox, type Box } from "./boardGeometry";
import { boardArtFor } from "./boardArt";
import { BOARD_VERBS } from "./boardVerbs";
import { BOARD_ART } from "./boardArt";

export * from "./boardGeometry";
export * from "./boardLayout";
export * from "./boardArt";
export * from "./boardTemplates";
export { BOARD_VERBS, parseVerbArgs } from "./boardVerbs";

// "session" is the board's workshop state (dot vote, timer): one undrawn element, key el_session.
export const BOARD_KINDS = ["sticky", "text", "shape", "connector", "frame", "pen", "image", "stamp", "card", "session"] as const;
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
    case "sticky": {
      parts.push(String(el.color ?? "yellow"), fmtBox(b));
      if (el.icon) parts.push(String(el.icon));
      parts.push(quote(el.text));
      // Say when the words no longer fit, so an agent fixes it without a screenshot.
      const need = stickyFitHeight(String(el.text ?? ""), b.w, b.h, stickyIconHeight(el.icon, boardArtFor(el.icon) !== null, b.w, b.h));
      if (need > b.h + 2) parts.push(`OVERFLOWS: needs h${need}`);
      break;
    }
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

/** Pairs of cards, shapes and text that cover each other (stamps, pens, frames and arrows sit on things on purpose). */
function overlaps(els: readonly ArtifactElement[], max = 20): string[] {
  const solid = els.filter((e) => e.kind === "sticky" || e.kind === "shape" || e.kind === "text" || e.kind === "card" || e.kind === "image");
  const boxes = solid.map((e) => elementBox(e));
  const out: string[] = [];
  for (let i = 0; i < solid.length && out.length < max; i++) {
    for (let j = i + 1; j < solid.length && out.length < max; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      // A few pixels of touch is layout, not a clash.
      // One holding the other whole is a backdrop (a band, a panel), not a clash.
      if (ox > 4 && oy > 4 && !contains(a, b) && !contains(b, a)) out.push(`${solid[i].key}×${solid[j].key}`);
    }
  }
  return out;
}

export function describeBoard(whole: ArtifactView): string {
  // The workshop state (a dot vote, a timer) is one undrawn element; it reads as a line, never as content.
  const session = whole.elements.find((e) => e.kind === "session");
  const view = session ? { ...whole, elements: whole.elements.filter((e) => e !== session) } : whole;
  if (view.elements.length === 0) return `board "${view.title}": empty. Start anywhere; 0,0 is a fine top-left.`;
  const content = unionBox(view.elements.filter((e) => e.kind !== "connector").map(elementBox));
  const head = `board "${view.title}" · ${view.elements.length} elements` +
    (content ? ` · content ${Math.round(content.x)},${Math.round(content.y)} → ${Math.round(content.x + content.w)},${Math.round(content.y + content.h)}` : "") +
    " · x right, y down, boxes are x,y wxh";
  const lines = readingOrder(view.elements).map((e) => describeElement(e, view));
  const groups = new Map<string, string[]>();
  for (const e of view.elements) if (typeof e.group === "string") groups.set(e.group, [...(groups.get(e.group) ?? []), e.key]);
  for (const [g, keys] of groups) lines.push(`group ${g}: ${keys.join(" ")}`);
  const clashes = overlaps(view.elements);
  if (clashes.length) lines.push(`OVERLAPPING (move apart, or ignore if meant): ${clashes.join("  ")}`);
  const votes = view.elements.filter((e) => Array.isArray(e.votes) && e.votes.length).sort((x, y) => (y.votes as unknown[]).length - (x.votes as unknown[]).length);
  const voting = session?.voting as { open?: boolean } | null | undefined;
  if (voting || votes.length) lines.push(`${voting?.open ? "dot vote open" : "dot vote"}: ${votes.length ? votes.map((e) => `${e.key} ${(e.votes as unknown[]).length}`).join(", ") : "no votes yet"}`);
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
    "Item lines (place, add): `[kind[:variant...]] text`, ` | ` breaks a line; a leading `:name:` on a sticky gives it a painted illustration.",
    "  Lock flavor | Huckleberry it is        sticky:green :berries: Lock flavor        shape:diamond:blue Ship?        text:36 Heading        card ct-4102        stamp 🎉",
    `Illustrations (use them on cards a person should scan; one per card, matching its subject): ${BOARD_ART.join(" ")}.`,
    "Timeline stops: `label | title | body | illustration | color`, e.g. `Day 1 | Lock flavor | Huckleberry it is | berries | yellow`. One call draws the title, road, pills and stemmed cards; the last stop is drawn as the goal (a larger card at the road's end).",
    "Rows by columns (journey map, comparison, swimlanes): `cast board matrix <doc> --cols \"A,B,C\" --cell 200x160` with `Row label :: item :: item :: item` per stdin line. Size any item with `:w240:h120` variants or --w/--h.",
    "Change words without losing a key or its arrows: `cast board edit <doc> <key> New title | body` (--icon, --color). Start over: `cast board clear <doc>`.",
    "A sticky marked OVERFLOWS in `read` has more words than room: shorten it or `edit` it (edit grows it to fit).",
    "Starting a retro, kanban, roadmap, timeline or brainstorm: `cast board template <doc> <name>`, then fill its stickies by key.",
    "Diagrams (architecture, flows): shapes in a grid with `place --cols`, then `connect --elbow` so arrows run at right angles around boxes; label an arrow with --label. Elbow arrows land where they line up with the other end, so several arrows into a wide box stay apart; pin an end with --from-at/--to-at fx,fy (0.25,1 = a quarter along the bottom). Arrows can attach to frames.",
    "Themes: `Theme name: el_a el_b el_c` per line regroups existing stickies into titled frames.",
    "Colors: yellow orange red pink violet blue cyan green gray. Shapes: rect ellipse diamond pill triangle hexagon cylinder (a database) star.",
    "Stickers: `stamp 🎉` is a small emoji reaction; `stamp rocket` (any illustration name) places the painted illustration as a 120px sticker.",
    "Fields for `apply`: every element x y w h z rot group; sticky text color icon; text text size weight(bold) color align(left|center|right); shape shape text color solid icon; frame title color; connector from to (keys) or x1 y1 x2 y2, curve(curved|elbow) arrow(end|both|none) label label_at(0..1) color dash width; pen points [x,y,...] color width opacity; stamp emoji size; card ref; image src alt. Text takes **bold**, *italic*, - lists and links.",
    "Live codecast objects go on as cards: `cast board card <doc> ct-123`. Stickies into tasks: `cast task create` each, then `cast board card <doc> <ct-id> --replace <sticky key>` (same key, arrows stay attached).",
    "Anything else: `cast board apply <doc>` with raw ops; give each put a z (`read` shows the top), or it lands behind what is there.",
  ].join("\n"),
};
