// `cast board <verb>` (ct-91884): the layout helpers an agent needs to lay a
// board out cleanly without computing coordinates itself. Each verb is pure:
// the board as it stands plus arguments in, ops out. The CLI writes them and
// moves the agent's cursor to what it wrote.
import type { ArtifactElement, ArtifactOp, Json } from "./core";
import type { ArtifactVerb, ArtifactView, VerbResult } from "./spec";
import { newElementKey } from "./spec";
import {
  BOARD_COLORS,
  alignBoxes,
  center,
  distributeBoxes,
  elementBox,
  unionBox,
  type AlignMode,
  type Box,
  type Pt,
} from "./boardGeometry";
import {
  bottomZ,
  frameAround,
  freeSpot,
  gridPositions,
  nextZ,
  parseItem,
  parseItems,
  parseThemes,
  parseTimeline,
  placeItems,
  squareCols,
  themesOps,
  timelineOps,
} from "./boardLayout";

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

/** A group's members, each moved by the same offset. */
function moveOps(els: readonly ArtifactElement[], dx: number, dy: number): ArtifactOp[] {
  return els.filter((e) => e.kind !== "connector").map((e) => ({ k: e.key, set: { x: Math.round(Number(e.x ?? 0) + dx), y: Math.round(Number(e.y ?? 0) + dy) } }));
}

const place: ArtifactVerb = {
  summary: "Place a list of items (one per stdin line) in a grid, row or column",
  usage: "place <doc> grid|row|column [--at x,y] [--cols n] [--gap 40] [--frame \"Title\"] < item lines",
  stdin: true,
  run(view, args, stdin) {
    const { pos, flags } = parseVerbArgs(args);
    const mode = pos[0] ?? "grid";
    if (!["grid", "row", "column"].includes(mode)) throw new Error("layout is grid, row or column");
    const items = parseItems(stdin ?? "");
    if (items.length === 0) throw new Error("no items on stdin (one per line)");
    const gap = count(flags.gap, "--gap", 40);
    const frameTitle = str(flags.frame);
    const pad = frameTitle ? 40 : 0;
    const spot = point(flags.at, "--at") ?? freeSpot(view);
    const at = { x: spot.x + pad, y: spot.y + (frameTitle ? pad + 24 : 0) };
    const cols = mode === "row" ? items.length : mode === "column" ? 1 : count(flags.cols, "--cols", squareCols(items.length, 5));
    const positions = gridPositions(items, { cols, gap, at });
    const { ops, keys } = placeItems(items, positions, nextZ(view));
    const boxes = boxesOf(ops);
    if (frameTitle) {
      const f = frameAround(boxes, frameTitle, bottomZ(view));
      if (f) { ops.unshift(f); keys.unshift(f.k); }
    }
    return done(ops, keys, `placed ${items.length} item${items.length === 1 ? "" : "s"} in a ${mode}`, view, boxes);
  },
};

const add: ArtifactVerb = {
  summary: "Add one element: an item line as arguments",
  usage: "add <doc> [kind[:variant...]] <text> [--at x,y] [--w n] [--h n]",
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args);
    const item = parseItem(pos.join(" "));
    if (!item) throw new Error("say what to add, e.g. `cast board add <doc> sticky:pink Launch party`");
    if (flags.w !== undefined) item.w = count(flags.w, "--w", item.w);
    if (flags.h !== undefined) item.h = count(flags.h, "--h", item.h);
    const at = point(flags.at, "--at") ?? freeSpot(view);
    const { ops, keys } = placeItems([item], [at], item.kind === "frame" ? bottomZ(view) : nextZ(view));
    return done(ops, keys, `added ${item.kind}`, view, boxesOf(ops));
  },
};

const timeline: ArtifactVerb = {
  summary: "Lay out an illustrated timeline: a road, a pill per stop, a card per stop",
  usage: "timeline <doc> [--title \"...\"] [--subtitle \"...\"] [--at x,y] [--step 190] [--road orange] [--pill red] < stop lines (label | title | body | emoji | color)",
  stdin: true,
  run(view, args, stdin) {
    const { flags } = parseVerbArgs(args);
    const stops = parseTimeline(stdin ?? "");
    if (stops.length === 0) throw new Error("no stops on stdin: `label | title | body | emoji | color` per line");
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
  usage: "connect <doc> <a> <b> [<c>...] [--curved] [--label \"...\"] [--arrow end|both|none] [--color gray] [--dashed]",
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args, ["curved", "dashed"]);
    const els = requireKeys(view, pos, 2);
    const arrow = str(flags.arrow) ?? "end";
    if (!["end", "both", "none"].includes(arrow)) throw new Error("--arrow is end, both or none");
    let z = nextZ(view);
    const ops: ArtifactOp[] = [];
    for (let i = 0; i + 1 < els.length; i++) {
      const fields: Record<string, Json> = { kind: "connector", from: els[i].key, to: els[i + 1].key, arrow, z: z++ };
      if (flags.curved) fields.curve = "curved";
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
  summary: "Move elements together, by an offset or to a spot",
  usage: "move <doc> <keys...> (--by dx,dy | --to x,y)",
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args);
    const els = requireKeys(view, pos);
    const by = point(flags.by, "--by");
    const to = point(flags.to, "--to");
    if (!by && !to) throw new Error("say --by dx,dy or --to x,y");
    const b = unionBox(els.map(elementBox))!;
    const dx = by ? by.x : to!.x - b.x, dy = by ? by.y : to!.y - b.y;
    const ops = moveOps(els, dx, dy);
    return done(ops, pos, `moved ${ops.length}`, view, [{ ...b, x: b.x + dx, y: b.y + dy }]);
  },
};

const frame: ArtifactVerb = {
  summary: "Wrap elements in a titled frame (a section)",
  usage: "frame <doc> \"<title>\" <keys...> [--pad 40] [--color blue]",
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args);
    const [title, ...keys] = pos;
    if (!title) throw new Error("give the frame a title");
    const els = requireKeys(view, keys);
    const op = frameAround(els.map(elementBox), title, bottomZ(view), count(flags.pad, "--pad", 40))!;
    if (str(flags.color) && "put" in op) op.put.color = str(flags.color)!;
    return done([op], [op.k], `framed ${els.length} as "${title}"`, view, els.map(elementBox));
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
  usage: "card <doc> <ref> [--at x,y] [--replace <key>]   ref: ct-123, pl-9, jx7abcd, doc:<id>, #42",
  run(view, args) {
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
    const at = point(flags.at, "--at") ?? freeSpot(view);
    const k = newElementKey("el");
    const op: ArtifactOp = { k, put: { kind: "card", ref, x: at.x, y: at.y, w: 320, h: 168, z: nextZ(view) } };
    return done([op], [k], `placed ${ref}`, view, boxesOf([op]));
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

export const BOARD_VERBS: Record<string, ArtifactVerb> = {
  add, place, timeline, connect, arrange, align, distribute, move, frame, themes, group, card, order,
};
