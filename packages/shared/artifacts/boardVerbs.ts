// `cast board <verb>` (ct-91884): the layout helpers an agent needs to lay a
// board out cleanly without computing coordinates itself. Each verb is pure:
// the board as it stands plus arguments in, ops out. The CLI writes them and
// moves the agent's cursor to what it wrote.
import type { ArtifactElement, ArtifactOp, Json } from "./core";
import type { ArtifactVerb, ArtifactView, VerbContext, VerbResult } from "./spec";
import { artifactView, newElementKey } from "./spec";
import { parsePublishedPageUrl } from "../entities";
import {
  BOARD_COLORS,
  BOARD_DEFAULT_SIZE,
  elementBounds,
  alignBoxes,
  center,
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
  carriedKeys,
  collapseFrameOps,
  enclosingFrameKeys,
  expandFrameOps,
  frameCollapsed,
  moveFrameOps,
  organizeOps,
  reflowFrameOps,
  FRAME_STATUSES,
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

/** The ids a verb's `--ref` / `--frame-ref` name, for the CLI to read titles of; bad ones are left to `run` to refuse. */
function refsIn(...flags: string[]) {
  return (args: string[]) => {
    const f = parseVerbArgs(args).flags;
    return flags.flatMap((n) => (typeof f[n] === "string" && /^(pri|in|pl|ct)-\d+$/i.test(f[n] as string) ? [(f[n] as string).trim().toLowerCase()] : []));
  };
}

const refTitle = (ref: string, ctx?: VerbContext) => ctx?.titles?.[ref] || ref;

/** Set ops folded into the puts of the same batch, so a new frame is written whole. */
function foldInto(ops: ArtifactOp[], more: readonly ArtifactOp[]): ArtifactOp[] {
  const out = [...ops];
  for (const op of more) {
    const i = out.findIndex((o) => o.k === op.k && "put" in o);
    if (i < 0 || !("set" in op)) { out.push(op); continue; }
    const put = { ...(out[i] as { put: Record<string, Json> }).put };
    for (const [f, v] of Object.entries(op.set)) if (v === null) delete put[f]; else put[f] = v;
    out[i] = { k: op.k, put: put as any };
  }
  return out;
}

/**
 * Agent courtesy: an agent folding or unfolding a frame inside a frame that
 * holds a person's element leaves that enclosing frame as it was. Answers the
 * enclosing frame left alone, or null when the enclosing reflow may run.
 */
function courtesyFrame(view: ArtifactView, key: string, ctx?: VerbContext): string | null {
  if (!ctx?.agent) return null;
  const around = enclosingFrameKeys(view, key);
  if (!around.length) return null;
  const outer = around[around.length - 1];
  const person = carriedKeys(view, [outer]).some((k) => k !== outer && String(view.get(k)?.by ?? "").startsWith("u:"));
  return person ? around[0] : null;
}

/** Fold or unfold `key`, minding courtesy: the ops, and the line saying an enclosing frame was left as it was. */
function foldOps(view: ArtifactView, key: string, fold: "collapse" | "expand", ctx?: VerbContext): { ops: ArtifactOp[]; note: string | null } {
  const left = courtesyFrame(view, key, ctx);
  const ops = (fold === "collapse" ? collapseFrameOps : expandFrameOps)(view, key, left ? { reflowParent: false } : {});
  return { ops, note: left ? `left the enclosing frame ${left} as it was: it holds a person's work` : null };
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
  refs: refsIn("frame-ref"),
  run(view, args, stdin, ctx) {
    const { pos, flags } = parseVerbArgs(args);
    const mode = pos[0] ?? "grid";
    if (!["grid", "row", "column"].includes(mode)) throw new Error("layout is grid, row or column");
    const sw = flags.w !== undefined ? count(flags.w, "--w", 0) : undefined, sh = flags.h !== undefined ? count(flags.h, "--h", 0) : undefined;
    const items = parseItems(stdin ?? "").map((it) => (sw !== undefined || sh !== undefined ? resizeItem(it, sw, sh) : it));
    if (items.length === 0) throw new Error("no items on stdin (one per line)");
    const gap = count(flags.gap, "--gap", 40);
    // A frame titled by an entity: its chip is the title, the entity's words (or its id) the fallback.
    const ref = frameRefArg(flags["frame-ref"], "--frame-ref");
    const frameTitle = str(flags.frame) ?? (ref ? refTitle(ref, ctx) : undefined);
    const pad = frameTitle ? 40 : 0;
    const spot = point(flags.at, "--at") ?? freeSpot(view);
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
    return done(ops, keys, `placed ${items.length} item${items.length === 1 ? "" : "s"} in a ${mode}`, view, boxes);
  },
};

const add: ArtifactVerb = {
  summary: "Add one element: an item line as arguments",
  usage: "add <doc> [kind[:color][:shape][:w240][:h120]] [:art:] <text | more lines> [--at x,y] [--w n] [--h n]   e.g. add <doc> sticky:green :rocket: Launch | Out to everyone",
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args);
    let item = parseItem(pos.join(" "));
    if (!item) throw new Error("say what to add, e.g. `cast board add <doc> sticky:pink Launch party`");
    if (flags.w !== undefined || flags.h !== undefined) item = resizeItem(item, flags.w !== undefined ? count(flags.w, "--w", item.w) : undefined, flags.h !== undefined ? count(flags.h, "--h", item.h) : undefined);
    const at = point(flags.at, "--at") ?? freeSpot(view);
    const { ops, keys } = placeItems([item], [at], item.kind === "frame" ? bottomZ(view) : nextZ(view));
    return done(ops, keys, `added ${item.kind}`, view, boxesOf(ops));
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
  usage: "edit <doc> <key> [text | more lines] [--icon name|emoji|none] [--color c]   frames also: [--status open|leaning|decided|parked|none] [--ref pri-N|in-N|pl-N|ct-N|none]",
  refs: refsIn("ref"),
  run(view, args, _stdin, ctx) {
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
    const status = str(flags.status);
    const refFlag = str(flags.ref);
    if (status || refFlag) {
      if (el.kind !== "frame") throw new Error("--status and --ref are a frame's");
      if (status) {
        if (status !== "none" && !(FRAME_STATUSES as readonly string[]).includes(status)) throw new Error(`--status is ${FRAME_STATUSES.join(", ")} or none`);
        set.status = status === "none" ? null : status;
      }
      if (refFlag === "none") set.ref = null;
      else if (refFlag) {
        set.ref = frameRefArg(refFlag, "--ref")!;
        // New words win; otherwise the title follows the entity.
        if (!words) set.title = refTitle(set.ref as string, ctx);
      }
    }
    if (!Object.keys(set).length) throw new Error("say what to change: new words, --icon or --color (frames: --status, --ref)");
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
  run(view, args) {
    const { pos, flags } = parseVerbArgs(args);
    const els = requireKeys(view, pos);
    const by = point(flags.by, "--by");
    const to = point(flags.to, "--to");
    if (!by && !to) throw new Error("say --by dx,dy or --to x,y");
    const b = unionBox(els.map(elementBox))!;
    const dx = by ? by.x : to!.x - b.x, dy = by ? by.y : to!.y - b.y;
    // A frame (or folded pill) carries its contents, what it holds and the arrows inside it.
    const ops = moveFrameOps(view, pos, dx, dy);
    return done(ops, pos, `moved ${ops.length}`, view, [{ ...b, x: b.x + dx, y: b.y + dy }]);
  },
};

const frame: ArtifactVerb = {
  summary: "Wrap elements in a titled frame (a section), optionally titled by a codecast object and folded at once",
  usage: "frame <doc> \"<title>\" <keys...> [--ref pri-N|in-N|pl-N|ct-N] [--status open|leaning|decided|parked] [--collapse] [--pad 40] [--color blue]   (or --title \"<title>\" <keys...>; with --ref the title may be left out)",
  refs: refsIn("ref"),
  run(view, args, _stdin, ctx) {
    const { pos, flags } = parseVerbArgs(args, ["collapse"]);
    const ref = frameRefArg(flags.ref, "--ref");
    // The title is the first word, or --title (then every word is a key); with --ref and a first word that is a key, the entity titles it.
    const [title, ...keys] = str(flags.title) ? [str(flags.title)!, ...pos] : ref && pos[0] && view.get(pos[0]) ? [refTitle(ref, ctx), ...pos] : pos;
    if (!title) throw new Error("give the frame a title");
    const status = str(flags.status);
    if (status && !(FRAME_STATUSES as readonly string[]).includes(status)) throw new Error(`--status is ${FRAME_STATUSES.join(", ")}`);
    const els = requireKeys(view, keys);
    const op = frameAround(els.map(elementBox), title, bottomZ(view), count(flags.pad, "--pad", 40))!;
    if ("put" in op) {
      if (str(flags.color)) op.put.color = str(flags.color)!;
      if (ref) op.put.ref = ref;
      if (status) op.put.status = status;
    }
    if (!flags.collapse) return done([op], [op.k], `framed ${els.length} as "${title}"`, view, els.map(elementBox));
    // Framed and folded in one batch: fold the new frame as if it were already there.
    const framed = artifactView(view.type, view.title, [...view.elements, { ...(op as { put: Record<string, Json> }).put, key: op.k, rev: 0 } as ArtifactElement]);
    const fold = foldOps(framed, op.k, "collapse", ctx);
    const ops = foldInto([op], fold.ops);
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
  run(view, args) {
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
    const at = point(flags.at, "--at") ?? (near ? besideSpot(view, requireKeys(view, [near])[0], size) : freeSpot(view));
    const k = newElementKey("el");
    const op: ArtifactOp = { k, put: { ...fields, x: at.x, y: at.y, ...size, z: nextZ(view) } as any };
    return done([op], [k], `placed page ${slug}`, view, boxesOf([op]));
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
      const { ops, note } = foldOps(view, el.key, fold, ctx);
      // The holds: the fold's new `collapsed`, or the one an expand clears.
      const folded = fold === "collapse" ? frameCollapsed({ ...el, ...(ops.find((o) => o.k === el.key) as { set?: Record<string, Json> })?.set } as ArtifactElement) : frameCollapsed(el);
      const n = folded?.holds.filter((k) => view.get(k)).length ?? 0;
      const status = fold === "collapse" ? `collapsed ${el.key} (${n} held)` : `expanded ${el.key} (${n} shown)`;
      return done(ops, [el.key], [status, note].filter(Boolean).join("\n"), view, [boxAfter(view, el.key, ops)]);
    },
  };
}

const reflow: ArtifactVerb = {
  summary: "Lay a frame's contents out and size it to fit; with no frame, organize the whole board (frames in a grid, loose items below)",
  usage: "reflow <doc> [frame]",
  run(view, args) {
    const { pos } = parseVerbArgs(args);
    const key = pos[0];
    if (key) {
      const [el] = requireKeys(view, [key]);
      if (el.kind !== "frame") throw new Error(`${el.key} is a ${el.kind}, not a frame`);
    }
    const ops = key ? reflowFrameOps(view, key) : organizeOps(view);
    if (!ops.length) return { ops, status: key ? `${key} is already laid out` : "the board is already organized" };
    const keys = key ? [key] : [...new Set(ops.map((o) => o.k))];
    return done(ops, keys, key ? `reflowed ${key}` : `organized the board (${ops.length} moved)`, view, key ? [boxAfter(view, key, ops)] : undefined);
  },
};

export const BOARD_VERBS: Record<string, ArtifactVerb> = {
  add, place, template, matrix, edit, clear, timeline, connect, arrange, align, distribute, move, frame, collapse: foldVerb("collapse"), expand: foldVerb("expand"), reflow, themes, group, card, page, order,
};
