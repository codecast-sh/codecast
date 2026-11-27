// `cast board <verb>` (ct-91884): the layout helpers an agent needs to lay a
// board out cleanly without computing coordinates itself. Each verb is pure:
// the board as it stands plus arguments in, ops out. The CLI writes them and
// moves the agent's cursor to what it wrote.
import { coalesceOps, type ArtifactElement, type ArtifactOp, type Json } from "./core";
import type { ArtifactVerb, ArtifactView, VerbContext, VerbResult } from "./spec";
import { artifactView, newElementKey } from "./spec";
import { parsePublishedPageUrl } from "../entities";
import {
  BOARD_COLORS,
  BOARD_DEFAULT_SIZE,
  elementBounds,
  alignBoxes,
  center,
  contains,
  distributeBoxes,
  elementBox,
  stickyFitHeight,
  stickyIconHeight,
  unionBox,
  type AlignMode,
  type Box,
  type Pt,
} from "./boardGeometry";
import {
  bottomZ,
  clearOffset,
  frameAround,
  freeSpot,
  gridPositions,
  itemText,
  nextZ,
  matrixOps,
  parseItem,
  parseItems,
  parseMatrix,
  resizeItem,
  parseThemes,
  parseTimeline,
  placeItems,
  squareCols,
  themesOps,
  timelineOps,
} from "./boardLayout";
import { BOARD_TEMPLATES, isBoardTemplate, templateOps } from "./boardTemplates";
import {
  agentCollapseOps,
  collapseFrameOps,
  expandFrameOps,
  foldedCount,
  frameCollapsed,
  growToHoldOps,
  hiddenKeys,
  moveFrameOps,
  organizeOps,
  personTouched,
  reflowFrameOps,
} from "./boardFrames";
import { boardArtFor } from "./boardArt";

type Flags = { pos: string[]; flags: Record<string, string | true> };

/** `a b --gap 40 --curved c` -> pos [a b c], flags {gap:"40", curved:true}. `bools` never take a value. */
export function parseVerbArgs(args: readonly string[], bools: readonly string[] = []): Flags {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2);
      if (inline !== undefined) flags[name] = inline;
      else if (bools.includes(name) || i + 1 >= args.length || args[i + 1].startsWith("--")) flags[name] = true;
      else flags[name] = args[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

function point(v: string | true | undefined, what: string): Pt | null {
  if (v === undefined) return null;
  const m = typeof v === "string" ? /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(v.trim()) : null;
  if (!m) throw new Error(`${what} takes x,y (e.g. 120,-40)`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

function count(v: string | true | undefined, what: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} takes a number`);
  return n;
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function requireKeys(view: ArtifactView, keys: readonly string[], min = 1): ArtifactElement[] {
  if (keys.length < min) throw new Error(`name at least ${min} element key${min === 1 ? "" : "s"} (see \`cast board read\`)`);
  return keys.map((k) => {
    const el = view.get(k);
    if (!el) throw new Error(`no element ${k} on this board`);
    return el;
  });
}

function done(ops: ArtifactOp[], keys: string[], status: string, view: ArtifactView, boxes?: Box[]): VerbResult {
  const b = unionBox(boxes ?? []);
  return { ops, status: `${status}\nkeys: ${keys.join(" ")}`, ...(b ? { position: { point: center(b) } } : {}) };
}

function boxesOf(ops: readonly ArtifactOp[]): Box[] {
  return ops.flatMap((op) => ("put" in op && op.put.kind !== "connector" ? [elementBox({ ...(op.put as any), key: op.k, rev: 0 })] : []));
}

/** A frame's entity: a priority, goal, plan or task short id, lowercased. */
export function frameRefArg(v: string | true | undefined, flag: string): string | undefined {
  if (v === undefined) return undefined;
  const m = typeof v === "string" ? /^(pri|in|pl|ct)-\d+$/i.exec(v.trim()) : null;
  if (!m) throw new Error(`${flag} takes a priority, goal, plan or task id: pri-N, in-N, pl-N or ct-N`);
  return v.toString().trim().toLowerCase();
}

/** Agent courtesy, for verbs that lay out more than they were asked to. */
function frameName(view: ArtifactView, key: string): string {
  const t = view.get(key)?.title;
  return typeof t === "string" && t.trim() ? `"${t.trim()}"` : key;
}

/** Fold `key`; an agent's fold reflows the frames around it only as far as no person's element is touched. */
function collapseOps(view: ArtifactView, key: string, ctx?: VerbContext): { ops: ArtifactOp[]; note: string | null } {
  if (!ctx?.agent) return { ops: collapseFrameOps(view, key), note: null };
  const { ops, leftAsItWas } = agentCollapseOps(view, key);
  return { ops, note: leftAsItWas ? `left ${frameName(view, leftAsItWas)} as it was: it holds a person's work` : null };
}

/** The people's elements an agent's batch would touch; none for a person's command. */
function touchedPeople(view: ArtifactView, ops: readonly ArtifactOp[], asked: readonly string[], ctx?: VerbContext): string[] {
  return ctx?.agent ? personTouched(view, ops, asked) : [];
}

/** An agent's whole-batch layout (frame, expand, reflow, organize, move) that would touch a person's element is refused, nothing written. */
function refuseForPeople(view: ArtifactView, ops: readonly ArtifactOp[], asked: readonly string[], ctx?: VerbContext) {
  const touched = touchedPeople(view, ops, asked, ctx);
  if (!touched.length) return;
  throw new Error(`left the board as it was: this would move or enclose a person's work (${touched.join(", ")}). A person can press Reflow or Organize on the board.`);
}

/**
 * The padding for a new frame around `els`: `pad`, or less when they all sit
 * inside one frame, so the new frame lands strictly inside it (8px clear of
 * its edge) and never ties with it for containment.
 */
function insetPad(view: ArtifactView, els: readonly ArtifactElement[], pad: number): number {
  const u = unionBox(els.map(elementBounds));
  if (!u) return pad;
  const hidden = hiddenKeys(view);
  const keys = new Set(els.map((e) => e.key));
  const around = view.elements
    .filter((f) => f.kind === "frame" && !keys.has(f.key) && !hidden.has(f.key) && !frameCollapsed(f) && contains(elementBounds(f), u))
    .map(elementBounds)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0];
  if (!around) return pad;
  // frameAround puts the title band (24) above the padding.
  const gap = Math.min(u.x - around.x, u.y - around.y - 24, around.x + around.w - u.x - u.w, around.y + around.h - u.y - u.h);
  return Math.max(0, Math.min(pad, gap - 8));
}

/**
 * New elements put at `at` (an add-type verb's --at): when that point is inside
 * an open frame, the frame grows in the same batch to hold them, so they are
 * its children and a reflow lays them out. An agent's growth may not move or
 * enclose a person's element (the frame itself may grow): then the new
 * elements go in where asked and the frame stays as it was.
 */
function intoFrame(view: ArtifactView, ops: ArtifactOp[], keys: readonly string[], at: Pt | null, ctx?: VerbContext): { ops: ArtifactOp[]; note: string | null } {
  if (!at) return { ops, note: null };
  const placed = artifactView(view.type, view.title, [...view.elements, ...ops.flatMap((o) => ("put" in o ? [{ ...o.put, key: o.k, rev: 0 } as ArtifactElement] : []))]);
  const grow = growToHoldOps(placed, keys, at);
  if (!grow.frame || !grow.ops.length) return { ops, note: null };
  if (touchedPeople(placed, grow.ops, [grow.frame, ...keys], ctx).length) return { ops, note: `left ${frameName(view, grow.frame)} as it was: growing it would move a person's work` };
  return { ops: coalesceOps([...ops, ...grow.ops]), note: `grew ${frameName(view, grow.frame)} to hold it` };
}

/** The frame's box after `ops`, from its put or its old box with the set fields. */
function boxAfter(view: ArtifactView, key: string, ops: readonly ArtifactOp[]): Box {
  const op = ops.find((o) => o.k === key);
  const base = op && "put" in op ? { ...(op.put as any), key, rev: 0 } : view.get(key)!;
  return elementBox({ ...base, ...(op && "set" in op ? op.set : {}) } as ArtifactElement);
}

const place: ArtifactVerb = {
  summary: "Place a list of items (one per stdin line) in a grid, row or column",
  usage: "place <doc> grid|row|column [--at x,y] [--cols n] [--gap 40] [--w n] [--h n] [--frame \"Title\"] [--frame-ref pri-N|in-N|pl-N|ct-N] [--frame-color c] < item lines (`[kind[:color][:shape][:w240][:h120]] [:art:] text | more`)",
  stdin: true,
  run(view, args, stdin, ctx) {
    const { pos, flags } = parseVerbArgs(args);
    const mode = pos[0] ?? "grid";
    if (!["grid", "row", "column"].includes(mode)) throw new Error("layout is grid, row or column");
    const sw = flags.w !== undefined ? count(flags.w, "--w", 0) : undefined, sh = flags.h !== undefined ? count(flags.h, "--h", 0) : undefined;
    const items = parseItems(stdin ?? "").map((it) => (sw !== undefined || sh !== undefined ? resizeItem(it, sw, sh) : it));
    if (items.length === 0) throw new Error("no items on stdin (one per line)");
    const gap = count(flags.gap, "--gap", 40);
    // A frame about an entity: its chip resolves per viewer; the title is the caller's words, or the bare id.
    const ref = frameRefArg(flags["frame-ref"], "--frame-ref");
    const frameTitle = str(flags.frame) ?? ref;
    const pad = frameTitle ? 40 : 0;
    const anchor = point(flags.at, "--at");
    const spot = anchor ?? freeSpot(view);
    const at = { x: spot.x + pad, y: spot.y + (frameTitle ? pad + 24 : 0) };
    const cols = mode === "row" ? items.length : mode === "column" ? 1 : count(flags.cols, "--cols", squareCols(items.length, 5));
    const positions = gridPositions(items, { cols, gap, at });
    const { ops, keys } = placeItems(items, positions, nextZ(view));
    const boxes = boxesOf(ops);
    if (frameTitle) {
      const fc = str(flags["frame-color"]);
      if (fc && !(BOARD_COLORS as readonly string[]).includes(fc)) throw new Error(`colors: ${BOARD_COLORS.join(", ")}`);
      const f = frameAround(boxes, frameTitle, bottomZ(view), 40, fc);
      if (f && "put" in f && ref) f.put.ref = ref;
      if (f) { ops.unshift(f); keys.unshift(f.k); }
    }
    // Without --frame, items placed inside a frame become its children (a new frame is a section of its own).
    const into = frameTitle ? { ops, note: null } : intoFrame(view, ops, keys, anchor, ctx);
    return done(into.ops, keys, [`placed ${items.length} item${items.length === 1 ? "" : "s"} in a ${mode}`, into.note].filter(Boolean).join("\n"), view, boxes);
  },
};

const add: ArtifactVerb = {
  summary: "Add one element: an item line as arguments",
  usage: "add <doc> [kind[:color][:shape][:w240][:h120]] [:art:] <text | more lines> [--at x,y] [--w n] [--h n]   e.g. add <doc> sticky:green :rocket: Launch | Out to everyone",
  run(view, args, _stdin, ctx) {
    const { pos, flags } = parseVerbArgs(args);
    let item = parseItem(pos.join(" "));
    if (!item) throw new Error("say what to add, e.g. `cast board add <doc> sticky:pink Launch party`");
    if (flags.w !== undefined || flags.h !== undefined) item = resizeItem(item, flags.w !== undefined ? count(flags.w, "--w", item.w) : undefined, flags.h !== undefined ? count(flags.h, "--h", item.h) : undefined);
    const anchor = point(flags.at, "--at");
    const at = anchor ?? freeSpot(view);
    const { ops, keys } = placeItems([item], [at], item.kind === "frame" ? bottomZ(view) : nextZ(view));
    const into = intoFrame(view, ops, keys, anchor, ctx);
    return done(into.ops, keys, [`added ${item.kind}`, into.note].filter(Boolean).join("\n"), view, boxesOf(ops));
  },
};

const matrix: ArtifactVerb = {
  summary: "Lay out rows by columns (journey map, comparison, swimlanes): a pill per column, a titled band per row",
  usage: "matrix <doc> --cols \"Discover,Evaluate,Sign up\" [--title \"...\"] [--cell 200x160] [--gap 24] [--at x,y] [--color blue] < rows (`Row label :: item line :: item line`, `-` for an empty cell)",
  stdin: true,
  run(view, args, stdin) {
    const { flags } = parseVerbArgs(args);
    const rows = parseMatrix(stdin ?? "");
    if (rows.length === 0) throw new Error("no rows on stdin: `Row label :: item line :: item line` per line");
    const cols = (str(flags.cols) ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    const m = /^(\d+)x(\d+)$/.exec(str(flags.cell) ?? "200x160");
    if (!m) throw new Error("--cell takes WxH, e.g. 200x160");
    const color = str(flags.color);
    if (color && !(BOARD_COLORS as readonly string[]).includes(color)) throw new Error(`colors: ${BOARD_COLORS.join(", ")}`);
    const { ops, keys } = matrixOps(rows, {
      at: point(flags.at, "--at") ?? freeSpot(view),
      cols,
      cell: { w: Number(m[1]), h: Number(m[2]) },
      gap: count(flags.gap, "--gap", 24),
      title: str(flags.title),
      colColor: color,
      zFrame: bottomZ(view),
      z: nextZ(view),
    });
    return done(ops, keys, `laid out ${rows.length} rows by ${Math.max(cols.length, ...rows.map((r) => r.cells.length))} columns`, view, boxesOf(ops));
  },
};

const edit: ArtifactVerb = {
  summary: "Change an element's words (and illustration or color) in place; its key and arrows stay",
  usage: "edit <doc> <key> [text | more lines] [--icon name|emoji|none] [--color c]   frames also: [--ref pri-N|in-N|pl-N|ct-N|none]",
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args);
    const [el] = requireKeys(view, pos.slice(0, 1));
    const set: Record<string, Json> = {};
    const words = pos.slice(1).join(" ");
    const field = el.kind === "frame" ? "title" : el.kind === "connector" ? "label" : ["sticky", "text", "shape"].includes(el.kind) ? "text" : null;
    if (words) {
      if (!field) throw new Error(`a ${el.kind} has no words to edit`);
      set[field] = itemText(words);
    }
    const icon = str(flags.icon);
    if (icon) set.icon = icon === "none" ? null : icon.replace(/^:(.*):$/, "$1");
    const color = str(flags.color);
    if (color) {
      if (!(BOARD_COLORS as readonly string[]).includes(color)) throw new Error(`colors: ${BOARD_COLORS.join(", ")}`);
      set.color = color;
    }
    const refFlag = str(flags.ref);
    if (refFlag) {
      if (el.kind !== "frame") throw new Error("--ref is a frame's");
      const nextRef = refFlag === "none" ? null : frameRefArg(refFlag, "--ref")!;
      // Only what changes; the title stays unless new words are given (a frame with none takes the id).
      if (nextRef !== (el.ref ?? null)) {
        set.ref = nextRef;
        if (nextRef && !words && !(typeof el.title === "string" && el.title.trim())) set.title = nextRef;
      }
      if (!Object.keys(set).length) return { ops: [], status: `${el.key} already has that ref: nothing to write` };
    }
    if (!Object.keys(set).length) throw new Error("say what to change: new words, --icon or --color (frames: --ref)");
    if (el.kind === "sticky") {
      const b = elementBox(el);
      const text = String(set.text ?? el.text ?? "");
      const ic = "icon" in set ? set.icon : el.icon;
      const h = stickyFitHeight(text, b.w, b.h, stickyIconHeight(ic, boardArtFor(ic) !== null, b.w, b.h));
      if (h !== b.h) set.h = h;
    }
    if (el.kind === "text" && field) set.h = null;
    return done([{ k: el.key, set }], [el.key], `edited ${el.key}`, view, [elementBox({ ...el, ...set } as ArtifactElement)]);
  },
};

const clear: ArtifactVerb = {
  summary: "Delete everything on the board (a version is kept in history)",
  usage: "clear <doc>",
  run(view) {
    const keys = view.elements.map((e) => e.key);
    return { ops: keys.map((k) => ({ k, del: true as const })), status: `cleared ${keys.length} elements` };
  },
};

const template: ArtifactVerb = {
  summary: "Start from a template: retro, kanban, roadmap, timeline or brainstorm",
  usage: `template <doc> <${BOARD_TEMPLATES.join("|")}> [--title "..."] [--at x,y]`,
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args);
    const name = pos[0];
    if (!isBoardTemplate(name)) throw new Error(`templates: ${BOARD_TEMPLATES.join(", ")}`);
    const { ops, keys } = templateOps(name, point(flags.at, "--at") ?? freeSpot(view), bottomZ(view), nextZ(view), str(flags.title));
    return done(ops, keys, `laid out the ${name} template`, view, boxesOf(ops));
  },
};

const timeline: ArtifactVerb = {
  summary: "Lay out an illustrated timeline: a road, a pill per stop, a card per stop",
  usage: "timeline <doc> [--title \"...\"] [--subtitle \"...\"] [--at x,y] [--step 190] [--road orange] [--pill red] < stop lines (label | title | body | illustration | color)",
  stdin: true,
  run(view, args, stdin) {
    const { flags } = parseVerbArgs(args);
    const stops = parseTimeline(stdin ?? "");
    if (stops.length === 0) throw new Error("no stops on stdin: `label | title | body | illustration | color` per line");
    const road = str(flags.road), pill = str(flags.pill);
    for (const c of [road, pill]) if (c && !(BOARD_COLORS as readonly string[]).includes(c)) throw new Error(`colors: ${BOARD_COLORS.join(", ")}`);
    const { ops, keys } = timelineOps(stops, {
      at: point(flags.at, "--at") ?? freeSpot(view),
      step: flags.step !== undefined ? count(flags.step, "--step", 190) : undefined,
      title: str(flags.title),
      subtitle: str(flags.subtitle),
      road,
      pill,
      zBase: nextZ(view),
      zRoad: bottomZ(view),
    });
    return done(ops, keys, `laid out a ${stops.length}-stop timeline`, view, boxesOf(ops));
  },
};

const connect: ArtifactVerb = {
  summary: "Connect elements with arrows that stay attached (a b c chains a→b→c)",
  usage: "connect <doc> <a> <b> [<c>...] [--curved|--elbow] [--from-at fx,fy] [--to-at fx,fy] [--label \"...\"] [--arrow end|both|none] [--color gray] [--dashed]",
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args, ["curved", "elbow", "dashed"]);
    const els = requireKeys(view, pos, 2);
    const arrow = str(flags.arrow) ?? "end";
    if (!["end", "both", "none"].includes(arrow)) throw new Error("--arrow is end, both or none");
    let z = nextZ(view);
    const ops: ArtifactOp[] = [];
    for (let i = 0; i + 1 < els.length; i++) {
      const fields: Record<string, Json> = { kind: "connector", from: els[i].key, to: els[i + 1].key, arrow, z: z++ };
      if (flags.curved) fields.curve = "curved";
      if (flags.elbow) fields.curve = "elbow";
      for (const [flag, field] of [["from-at", "from_at"], ["to-at", "to_at"]] as const) {
        const v = flags[flag];
        if (v === undefined) continue;
        const m = typeof v === "string" ? /^(0?\.\d+|[01](?:\.0+)?),(0?\.\d+|[01](?:\.0+)?)$/.exec(v.trim()) : null;
        if (!m) throw new Error(`--${flag} takes fractions across the box, e.g. 0.5,1 for the bottom middle`);
        fields[field] = [Number(m[1]), Number(m[2])];
        fields.curve = "elbow";
      }
      if (flags.dashed) fields.dash = true;
      if (str(flags.label)) fields.label = str(flags.label)!;
      if (str(flags.color)) fields.color = str(flags.color)!;
      ops.push({ k: newElementKey("el"), put: fields as any });
    }
    return done(ops, ops.map((o) => o.k), `connected ${els.length} elements`, view, els.map(elementBox));
  },
};

const arrange: ArtifactVerb = {
  summary: "Re-lay existing elements in a grid, row or column (reading order kept)",
  usage: "arrange <doc> grid|row|column <keys...> [--cols n] [--gap 40] [--at x,y]",
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args);
    const [mode, ...keys] = pos;
    if (!["grid", "row", "column"].includes(mode ?? "")) throw new Error("layout is grid, row or column");
    const els = requireKeys(view, keys).filter((e) => e.kind !== "connector");
    if (els.length === 0) throw new Error("arrange moves shapes, stickies and cards; connectors follow what they connect");
    const boxes = els.map(elementBox);
    const order = els.map((e, i) => ({ e, b: boxes[i] })).sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x);
    const start = point(flags.at, "--at") ?? { x: Math.round(unionBox(boxes)!.x), y: Math.round(unionBox(boxes)!.y) };
    const cols = mode === "row" ? els.length : mode === "column" ? 1 : count(flags.cols, "--cols", squareCols(els.length, 5));
    const posns = gridPositions(order.map((o) => o.b), { cols, gap: count(flags.gap, "--gap", 40), at: start });
    const ops: ArtifactOp[] = order.map((o, i) => ({ k: o.e.key, set: { x: posns[i].x, y: posns[i].y } }));
    return done(ops, order.map((o) => o.e.key), `arranged ${els.length} in a ${mode}`, view, order.map((o, i) => ({ ...o.b, ...posns[i] })));
  },
};

const ALIGN_MODES: AlignMode[] = ["left", "hcenter", "right", "top", "vcenter", "bottom"];

const align: ArtifactVerb = {
  summary: "Align elements on an edge or center line",
  usage: "align <doc> left|hcenter|right|top|vcenter|bottom <keys...>",
  run(view, args) {
    const { pos } = parseVerbArgs(args);
    const [mode, ...keys] = pos;
    if (!ALIGN_MODES.includes(mode as AlignMode)) throw new Error(`align takes ${ALIGN_MODES.join("|")}`);
    const els = requireKeys(view, keys, 2);
    const moved = alignBoxes(new Map(els.map((e) => [e.key, elementBox(e)])), mode as AlignMode);
    const ops: ArtifactOp[] = [...moved].map(([k, p]) => ({ k, set: { x: p.x, y: p.y } }));
    return done(ops, keys, `aligned ${els.length} ${mode}`, view, els.map(elementBox));
  },
};

const distribute: ArtifactVerb = {
  summary: "Space three or more elements evenly",
  usage: "distribute <doc> h|v <keys...>",
  run(view, args) {
    const { pos } = parseVerbArgs(args);
    const [axis, ...keys] = pos;
    if (axis !== "h" && axis !== "v") throw new Error("distribute takes h or v");
    const els = requireKeys(view, keys, 3);
    const moved = distributeBoxes(new Map(els.map((e) => [e.key, elementBox(e)])), axis);
    const ops: ArtifactOp[] = [...moved].map(([k, p]) => ({ k, set: { x: p.x, y: p.y } }));
    return done(ops, keys, `distributed ${els.length}`, view, els.map(elementBox));
  },
};

const move: ArtifactVerb = {
  summary: "Move elements together, by an offset or to a spot; a frame carries what it holds",
  usage: "move <doc> <keys...> (--by dx,dy | --to x,y)",
  run(view, args, _stdin, ctx) {
    const { pos, flags } = parseVerbArgs(args);
    const els = requireKeys(view, pos);
    const by = point(flags.by, "--by");
    const to = point(flags.to, "--to");
    if (!by && !to) throw new Error("say --by dx,dy or --to x,y");
    const b = unionBox(els.map(elementBox))!;
    const dx = by ? by.x : to!.x - b.x, dy = by ? by.y : to!.y - b.y;
    // A frame (or folded pill) carries its contents, what it holds and the arrows inside it.
    const ops = moveFrameOps(view, pos, dx, dy);
    refuseForPeople(view, ops, pos, ctx);
    return done(ops, pos, `moved ${ops.length}`, view, [{ ...b, x: b.x + dx, y: b.y + dy }]);
  },
};

const frame: ArtifactVerb = {
  summary: "Wrap elements in a titled frame (a section), optionally about a codecast object and folded at once",
  usage: "frame <doc> \"<title>\" <keys...> [--ref pri-N|in-N|pl-N|ct-N] [--collapse] [--pad 40] [--color blue]   (or --title \"<title>\" <keys...>; with --ref the title may be left out and is the id)",
  run(view, args, _stdin, ctx) {
    const { pos, flags } = parseVerbArgs(args, ["collapse"]);
    const ref = frameRefArg(flags.ref, "--ref");
    // With --ref the title may be left out: a first word that is a key starts the keys, and one shaped like a key but missing is a typo.
    if (ref && !str(flags.title) && pos[0] && !view.get(pos[0]) && /^[a-z]+_[a-z0-9]+$/.test(pos[0])) throw new Error(`no element ${pos[0]} on this board`);
    const [title, ...keys] = str(flags.title) ? [str(flags.title)!, ...pos] : ref && pos[0] && view.get(pos[0]) ? [ref, ...pos] : pos;
    if (!title) throw new Error("give the frame a title");
    const els = requireKeys(view, keys);
    const op = frameAround(els.map(elementBox), title, bottomZ(view), insetPad(view, els, count(flags.pad, "--pad", 40)))!;
    if ("put" in op) {
      if (str(flags.color)) op.put.color = str(flags.color)!;
      if (ref) op.put.ref = ref;
    }
    // An agent's frame never boxes in a person's element it was not asked to frame.
    refuseForPeople(view, [op], keys, ctx);
    if (!flags.collapse) return done([op], [op.k], `framed ${els.length} as "${title}"`, view, els.map(elementBox));
    // Framed and folded in one batch: fold the new frame as if it were already there (an agent's fold never hides a person's element).
    const framed = artifactView(view.type, view.title, [...view.elements, { ...(op as { put: Record<string, Json> }).put, key: op.k, rev: 0 } as ArtifactElement]);
    const fold = collapseOps(framed, op.k, ctx);
    const ops = coalesceOps([op, ...fold.ops]);
    return done(ops, [op.k], [`framed ${els.length} as "${title}", collapsed`, fold.note].filter(Boolean).join("\n"), view, [boxAfter(framed, op.k, ops)]);
  },
};

const themes: ArtifactVerb = {
  summary: "Group elements into titled theme frames side by side",
  usage: "themes <doc> [--at x,y] < lines of `Theme name: el_a el_b el_c`",
  stdin: true,
  run(view, args, stdin) {
    const { flags } = parseVerbArgs(args);
    const parsed = parseThemes(stdin ?? "");
    if (parsed.length === 0) throw new Error("no themes on stdin: `Theme name: key key key` per line");
    const { ops, keys, missing } = themesOps(view, parsed, point(flags.at, "--at"), bottomZ(view));
    if (missing.length) throw new Error(`no element ${missing.join(", ")} on this board`);
    const boxes = ops.flatMap((op) => ("put" in op ? [elementBox({ ...(op.put as any), key: op.k, rev: 0 })] : []));
    return done(ops, keys, `grouped into ${parsed.length} themes`, view, boxes);
  },
};

const group: ArtifactVerb = {
  summary: "Group elements so they select and move together (ungroup with --off)",
  usage: "group <doc> <keys...> [--off]",
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args, ["off"]);
    const els = requireKeys(view, pos, flags.off ? 1 : 2);
    const id = flags.off ? null : newElementKey("g");
    const ops: ArtifactOp[] = els.map((e) => ({ k: e.key, set: { group: id } }));
    return done(ops, pos, flags.off ? `ungrouped ${els.length}` : `grouped ${els.length}`, view, els.map(elementBox));
  },
};

const card: ArtifactVerb = {
  summary: "Place a live codecast object (task, plan, session, PR, doc) as a card, or turn an element into one",
  usage: "card <doc> <ref> [--at x,y] [--replace <key>]   ref: ct-123, pl-9, jx7abcd, doc:<id>, #42   (--at inside a frame: the frame grows to hold it)",
  run(view, args, _stdin, ctx) {
    const { pos, flags } = parseVerbArgs(args);
    const ref = pos[0];
    if (!ref) throw new Error("name the object, e.g. ct-4102");
    const replace = str(flags.replace);
    if (replace) {
      const [el] = requireKeys(view, [replace]);
      const b = elementBox(el);
      // Same key: connectors to the sticky stay attached to the card.
      const op: ArtifactOp = { k: el.key, put: { kind: "card", ref, x: Math.round(b.x), y: Math.round(b.y), w: 320, h: 168, z: typeof el.z === "number" ? el.z : 0, ...(el.group ? { group: el.group } : {}) } };
      return done([op], [el.key], `${el.key} is now ${ref}`, view, [b]);
    }
    const anchor = point(flags.at, "--at");
    const at = anchor ?? freeSpot(view);
    const k = newElementKey("el");
    const op: ArtifactOp = { k, put: { kind: "card", ref, x: at.x, y: at.y, w: 320, h: 168, z: nextZ(view) } };
    const into = intoFrame(view, [op], [k], anchor, ctx);
    return done(into.ops, [k], [`placed ${ref}`, into.note].filter(Boolean).join("\n"), view, boxesOf([op]));
  },
};

/** A published page's slug from its share URL, serving URL or the bare slug; null for anything else. */
export function pageSlugOf(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9]{8,24}$/.test(s)) return s;
  return parsePublishedPageUrl(/^[a-z]+:\/\//i.test(s) || s.startsWith("/") ? s : `https://${s}`)?.slug ?? null;
}

/** Where a new element of `size` goes beside `key`: to its right, nudged off anything it would cover. */
export function besideSpot(view: Pick<ArtifactView, "elements">, key: ArtifactElement, size: { w: number; h: number }, gap = 40): Pt {
  const b = elementBox(key);
  const at = { x: Math.round(b.x + b.w + gap), y: Math.round(b.y) };
  const taken = view.elements.filter((e) => e.key !== key.key && e.kind !== "connector" && e.kind !== "pen" && e.kind !== "frame" && e.kind !== "session").map(elementBounds);
  const off = clearOffset({ ...at, ...size }, taken);
  return { x: at.x + off.x, y: at.y + off.y };
}

const page: ArtifactVerb = {
  summary: "Place a published page (`cast publish`) live on the board, or turn an element into one",
  usage: "page <doc> <url|slug> [--at x,y | --near <key>] [--w 640 --h 480] [--caption \"...\"] [--replace <key>]",
  run(view, args, _stdin, ctx) {
    const { pos, flags } = parseVerbArgs(args);
    const slug = pageSlugOf(pos[0] ?? "");
    if (!slug) throw new Error("name a published page: its https://codecast.sh/a/<slug> address or the slug");
    const d = BOARD_DEFAULT_SIZE.page;
    const size = { w: count(flags.w, "--w", d.w), h: count(flags.h, "--h", d.h) };
    const caption = str(flags.caption);
    const fields = { kind: "page", slug, ...(caption ? { caption } : {}) };
    const replace = str(flags.replace);
    if (replace) {
      const [el] = requireKeys(view, [replace]);
      const b = elementBox(el);
      // Same key: arrows into the element stay attached to the page.
      const box = { x: Math.round(b.x), y: Math.round(b.y), ...size };
      const op: ArtifactOp = { k: el.key, put: { ...fields, ...box, z: typeof el.z === "number" ? el.z : 0, ...(el.group ? { group: el.group } : {}) } as any };
      return done([op], [el.key], `${el.key} is now page ${slug}`, view, [box]);
    }
    const near = str(flags.near);
    const anchor = point(flags.at, "--at");
    const at = anchor ?? (near ? besideSpot(view, requireKeys(view, [near])[0], size) : freeSpot(view));
    const k = newElementKey("el");
    const op: ArtifactOp = { k, put: { ...fields, x: at.x, y: at.y, ...size, z: nextZ(view) } as any };
    const into = intoFrame(view, [op], [k], anchor, ctx);
    return done(into.ops, [k], [`placed page ${slug}`, into.note].filter(Boolean).join("\n"), view, boxesOf([op]));
  },
};

const order: ArtifactVerb = {
  summary: "Bring elements to the front or send them to the back",
  usage: "order <doc> front|back <keys...>",
  run(view, args) {
    const { pos } = parseVerbArgs(args);
    const [where, ...keys] = pos;
    if (where !== "front" && where !== "back") throw new Error("order takes front or back");
    const els = requireKeys(view, keys);
    let z = where === "front" ? nextZ(view) : bottomZ(view) - els.length + 1;
    const ops: ArtifactOp[] = els.map((e) => ({ k: e.key, set: { z: z++ } }));
    return done(ops, keys, `sent ${els.length} to the ${where}`, view, els.map(elementBox));
  },
};

function foldVerb(fold: "collapse" | "expand"): ArtifactVerb {
  return {
    summary: fold === "collapse"
      ? "Fold a frame into a title pill that hides and carries what it holds; the enclosing frame reflows"
      : "Unfold a collapsed frame, its contents back in place; the enclosing frame reflows, or what it now covers moves down",
    usage: `${fold} <doc> <frame>`,
    run(view, args, _stdin, ctx) {
      const { pos } = parseVerbArgs(args);
      const [el] = requireKeys(view, pos.slice(0, 1));
      if (el.kind !== "frame") throw new Error(`${el.key} is a ${el.kind}, not a frame`);
      const { ops, note } = fold === "collapse" ? collapseOps(view, el.key, ctx) : { ops: expandFrameOps(view, el.key), note: null };
      if (fold === "expand") refuseForPeople(view, ops, [el.key], ctx);
      // The holds: the fold's new `collapsed`, or the one an expand clears.
      const pill = fold === "collapse" ? ({ ...el, ...(ops.find((o) => o.k === el.key) as { set?: Record<string, Json> })?.set } as ArtifactElement) : el;
      const n = foldedCount(pill, view.get);
      const status = fold === "collapse" ? `collapsed ${el.key} (${n} held)` : `expanded ${el.key} (${n} shown)`;
      return done(ops, [el.key], [status, note].filter(Boolean).join("\n"), view, [boxAfter(view, el.key, ops)]);
    },
  };
}

const reflow: ArtifactVerb = {
  summary: "Lay a frame's contents out and size it to fit; with no frame, organize the whole board (frames in a grid, loose items below)",
  usage: "reflow <doc> [frame]",
  run(view, args, _stdin, ctx) {
    const { pos } = parseVerbArgs(args);
    const key = pos[0];
    if (key) {
      const [el] = requireKeys(view, [key]);
      if (el.kind !== "frame") throw new Error(`${el.key} is a ${el.kind}, not a frame`);
    }
    const ops = key ? reflowFrameOps(view, key) : organizeOps(view);
    refuseForPeople(view, ops, key ? [key] : [], ctx);
    if (!ops.length) return { ops, status: key ? `${key} is already laid out` : "the board is already organized" };
    const keys = key ? [key] : [...new Set(ops.map((o) => o.k))];
    return done(ops, keys, key ? `reflowed ${key}` : `organized the board (${ops.length} moved)`, view, key ? [boxAfter(view, key, ops)] : undefined);
  },
};

export const BOARD_VERBS: Record<string, ArtifactVerb> = {
  add, place, template, matrix, edit, clear, timeline, connect, arrange, align, distribute, move, frame, collapse: foldVerb("collapse"), expand: foldVerb("expand"), reflow, themes, group, card, page, order,
};
