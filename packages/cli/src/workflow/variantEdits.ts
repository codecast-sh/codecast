// A variant's edits (docs/architecture/pipeline.md PL3) written as the edges they mean, so a flow written with
// after=, skip or when= builds and hashes exactly as the same flow written out by hand. parser.ts inherit() calls
// variantEdits on each base-plus-variant merge, expands segments, then applyOverrides and withGuides.
import { SEGMENT_SEP, passScore } from "@codecast/shared/contracts/flowPool";
import { whenPaths, type FlowEditChange } from "@codecast/shared/contracts/flowEdit";
import { inlineRef, mentionsFailure, shapeOf, type Attr, type RawGraph, type ReadFile } from "./rawGraph";

/** The attributes that edit the flow a variant extends rather than describe a station. */
export const VARIANT_KEYS = ["after", "before", "skip", "when", "guide", "fix"] as const;
const truthy = (v: Attr | undefined) => v === true || v === "true";
const isExit = (a: Record<string, Attr> | undefined) => !!a && shapeOf(a) === "Msquare";
const isSegmentNode = (raw: RawGraph, id: string) => typeof raw.nodes.get(id)?.flow === "string" || !!raw.fills?.has(id);
const SAYS_SUCCESS = /\boutcome\s*=\s*success\b/;
const andCondition = (c: string | undefined, more: string) => (c ? `(${c}) and ${more}` : more);

/**
 * A variant's edits written as the edges they mean, so a flow written with
 * after=, skip or when= builds (and hashes) exactly as the same flow written
 * out by hand:
 *
 *   - `n [after="a"]` takes a's passing route: a -> n, n -> (where a went)
 *     on success, and on failure the way back a uses (the edge out of a whose
 *     condition says failure and leads to a station, not an end), or `fix=`.
 *     A second station after the same one follows the first. `before="a"`
 *     takes every edge into a instead.
 *   - `s [skip=true]` sends every edge into s to where s goes when it passes,
 *     and drops whatever the skip left unreachable.
 *   - `n [when="glob, glob"]` runs n only when $change_files touches a glob:
 *     each edge into n gains `change_files touches "..."`, and a twin edge
 *     with `not change_files touches "..."` goes past it.
 *   - `guide=` on a segment's node, and `prompt=` too, go to the one station
 *     of the segment that has a prompt (applied once it is expanded).
 */
export function variantEdits(raw: RawGraph, own: Map<string, Record<string, Attr>>, written: Map<string, Record<string, Attr>>, baseIds: Set<string>, baseName: string, here: string): RawGraph {
  const nodes = new Map([...raw.nodes].map(([id, a]) => [id, { ...a }]));
  let edges = [...raw.edges];
  const overrides = new Map(raw.overrides ?? []);
  const fills = new Map(raw.fills ?? []);
  const edits: FlowEditChange[] = [];
  const stations = () => [...nodes].filter(([id, a]) => !id.includes(SEGMENT_SEP) && shapeOf(a) !== "Mdiamond" && !isExit(a)).map(([id]) => id).join(", ");
  const say = (id: string, key: string, v: Attr) => `${here}: ${id} [${key}="${v}"]`;
  // A station's way on when it passes, and its ways back: an edge whose condition says failure, or a plain edge beside
  // one that says `outcome = success` (the "otherwise" of that station).
  const routesOf = (id: string) => {
    const out = edges.filter((e) => e.from === id);
    const rest = out.filter((e) => !mentionsFailure(e));
    const success = rest.filter((e) => SAYS_SUCCESS.test(e.condition ?? ""));
    const pass = success.length && success.length < rest.length ? success : rest;
    return { pass, back: out.filter((e) => !pass.includes(e)) };
  };
  const passingOut = (id: string) => routesOf(id).pass;
  const onePassTarget = (id: string, what: string): string => {
    const out = passingOut(id);
    const to = [...new Set(out.map((e) => e.to))];
    if (to.length === 1) return to[0];
    const onward = to.filter((t) => !isExit(nodes.get(t)));
    const ends = to.filter((t) => isExit(nodes.get(t)));
    if (!onward.length) throw new Error(`${what}: ${id} has no station after it when it passes${ends.length ? ` (it ends at ${ends.join(", ")})` : ""}, so there is nowhere to join; name a station that leads on`);
    // The station a passing run most likely goes on to: the route whose condition reads most like a pass.
    const best = out.filter((e) => onward.includes(e.to)).sort((a, b) => passScore(b) - passScore(a))[0].to;
    throw new Error(`${what}: ${id} goes on to ${onward.join(", ")}${ends.length ? ` (and ends at ${ends.join(", ")})` : ""} by what it finds, so there is no one way on; place the station before one of them (before="${best}")`);
  };
  // A fan-out runs only the stations its edges name, side by side, and goes on from the first join after them
  // (runner.ts executeFanout): a station placed, skipped or gated among them would not run as written.
  const isShape = (id: string, shape: string) => shapeOf(nodes.get(id) ?? {}) === shape;
  const fanAt = (x: string): { fan: string; join: string | null; isJoin: boolean } | null => {
    const fanOf = (b: string) => edges.find((e) => e.to === b && isShape(e.from, "component"))?.from;
    const joinOf = (fan: string) => edges.filter((e) => e.from === fan).flatMap((e) => edges.filter((f) => f.from === e.to).map((f) => f.to)).find((t) => isShape(t, "tripleoctagon")) ?? null;
    if (isShape(x, "component")) return { fan: x, join: joinOf(x), isJoin: false };
    const fan = fanOf(x);
    if (fan) return { fan, join: joinOf(fan), isJoin: false };
    if (isShape(x, "tripleoctagon")) {
      const from = edges.filter((e) => e.to === x).map((e) => fanOf(e.from)).find(Boolean);
      if (from) return { fan: from, join: x, isJoin: true };
    }
    return null;
  };
  const notInFan = (x: string, what: string, doing: string) => {
    const f = fanAt(x);
    if (!f) return;
    const where = x === f.fan ? `${x} is a fan-out, which runs its branches side by side`
      : f.isJoin ? `${x} is where the ${f.fan} fan-out joins its side-by-side branches`
      : `${x} is a branch of the ${f.fan} fan-out, which runs its branches side by side${f.join ? ` and goes on from ${f.join}` : ""}`;
    const instead = f.join ? `use the station before the fan-out (before="${f.fan}") or after the join (after="${f.join}")` : `use the station before the fan-out (before="${f.fan}")`;
    throw new Error(`${what}: ${where}, so ${doing} would not run as written; ${instead}`);
  };
  const reachable = () => {
    const seen = new Set<string>();
    const queue = [...nodes].filter(([, a]) => shapeOf(a) === "Mdiamond").map(([id]) => id);
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of edges) if (e.from === id) queue.push(e.to);
    }
    return seen;
  };

  const ownOverrides = new Set([...written.keys()].filter((k) => overrides.has(k) && k.includes(SEGMENT_SEP)));
  // Guidance and prompts on a segment's node belong to the station inside it that reads a prompt.
  for (const [id, a] of own) {
    if (!isSegmentNode(raw, id) || id.includes(SEGMENT_SEP)) continue;
    const moved = Object.fromEntries((["guide", "prompt"] as const).filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
    if (!Object.keys(moved).length) continue;
    overrides.set(id, { ...overrides.get(id), ...moved });
    ownOverrides.add(id);
    const n = nodes.get(id)!;
    delete n.guide;
    delete n.prompt;
  }
  for (const [id, a] of written) if (a.guide !== undefined) edits.push({ op: "guide", station: id });

  // Skips first: a station placed after a skipped one has nowhere to stand.
  const before = reachable();
  const skipped: string[] = [];
  for (const [id, a] of own) {
    if (!truthy(a.skip)) continue;
    const sk = nodes.get(id);
    if (sk && (shapeOf(sk) === "Mdiamond" || isExit(sk))) throw new Error(`${say(id, "skip", "true")}: ${id} ${shapeOf(sk) === "Mdiamond" ? "starts" : "ends"} the flow, so it cannot be skipped; skip a station between them`);
    if (!baseIds.has(id)) throw new Error(`${say(id, "skip", "true")}: ${baseName} has no station ${id} to skip; its stations: ${stations()}`);
    if (a.after !== undefined || a.before !== undefined) throw new Error(`${say(id, "skip", "true")}: a station is either skipped or placed, not both`);
    const changed = [...overrides.keys()].filter((k) => k === id || k.startsWith(`${id}${SEGMENT_SEP}`));
    // A base's changes to a station this file skips go with it; this file's own are a contradiction to name.
    for (const k of changed.filter((k) => !ownOverrides.has(k))) overrides.delete(k);
    if (changed.some((k) => ownOverrides.has(k))) throw new Error(`${say(id, "skip", "true")}: this file also changes ${changed.filter((k) => ownOverrides.has(k)).join(", ")}; a skipped station runs nothing, so drop those lines or the skip`);
    notInFan(id, say(id, "skip", "true"), "skipping it");
    const to = onePassTarget(id, say(id, "skip", "true"));
    // A station whose way back was the skipped one would go straight back to itself: a loop with nothing in it.
    const loop = edges.find((e) => e.to === id && e.from === to);
    if (loop) throw new Error(`${say(id, "skip", "true")}: ${to} goes to ${id}${loop.condition ? ` when ${loop.condition}` : ""}, and ${id} goes on to ${to}, so skipping it would send ${to} straight back to itself, again and again; skip another station, or write ${to}'s edges here`);
    edges = edges.filter((e) => e.from !== id).map((e) => (e.to === id ? { ...e, to } : e));
    nodes.delete(id);
    fills.delete(id);
    skipped.push(id);
    edits.push({ op: "skip", station: id });
  }
  const pruned = [...skipped];
  if (skipped.length) {
    const after = reachable();
    for (const id of before) {
      if (after.has(id) || skipped.includes(id) || !baseIds.has(id)) continue;
      nodes.delete(id);
      fills.delete(id);
      pruned.push(id);
    }
    edges = edges.filter((e) => !pruned.includes(e.from) && !pruned.includes(e.to));
  }

  // Inserts, in the order written.
  const lastAfter = new Map<string, string>();
  for (const [id, a] of own) {
    const anchorKey = a.after !== undefined ? "after" : a.before !== undefined ? "before" : null;
    if (!anchorKey) {
      if (a.fix !== undefined) throw new Error(`${say(id, "fix", a.fix)}: fix= says where a placed station's failure goes; place ${id} with after= or before=`);
      continue;
    }
    if (a.after !== undefined && a.before !== undefined) throw new Error(`${say(id, "after", a.after)}: a station goes after one station or before one, not both`);
    const anchor = String(a[anchorKey]);
    const what = say(id, anchorKey, anchor);
    if (baseIds.has(id)) throw new Error(`${what}: ${baseName} already has a station ${id}; ${anchorKey}= adds a new one, so give it a new id`);
    if (edges.some((e) => e.from === id)) throw new Error(`${what}: ${id} is placed with ${anchorKey}= and also routed here; keep one: drop its edges, or drop ${anchorKey}=`);
    if (anchor.includes(SEGMENT_SEP)) throw new Error(`${what}: ${anchor} is a step inside the ${anchor.split(SEGMENT_SEP)[0]} segment; place ${id} ${anchorKey} the segment itself (${anchorKey}="${anchor.split(SEGMENT_SEP)[0]}")`);
    if (pruned.includes(anchor)) throw new Error(`${what}: this file skips ${anchor}; place ${id} next to a station that stays`);
    if (!nodes.has(anchor) && !edges.some((e) => e.from === anchor || e.to === anchor)) throw new Error(`${what}: ${baseName} has no station ${anchor}; its stations: ${stations()}`);
    if (shapeOf(nodes.get(anchor) ?? {}) === "Mdiamond" && anchorKey === "before") throw new Error(`${what}: nothing comes before the start; place ${id} after="${anchor}"`);
    if (isExit(nodes.get(anchor)) && anchorKey === "after") throw new Error(`${what}: ${anchor} ends the flow; place ${id} before="${anchor}"`);
    if (anchorKey === "before" || !isShape(anchor, "tripleoctagon")) notInFan(anchor, what, `placing ${id} ${anchorKey} it`);
    // The way back a failure takes: fix=, else the anchor's own (to a station, not an end).
    let fix: string | null = null;
    if (a.fix !== undefined) {
      fix = String(a.fix);
      if (!nodes.has(fix) && !edges.some((e) => e.from === fix || e.to === fix)) throw new Error(`${say(id, "fix", fix)}: there is no station ${fix} to send a failure to; its stations: ${stations()}`);
    } else {
      const ways = routesOf(anchor).back.filter((e) => !isExit(nodes.get(e.to)));
      const back = [...new Set(ways.map((e) => e.to))];
      if (back.length > 1 && !ways.some(mentionsFailure)) throw new Error(`${what}: ${anchor} routes on its exit codes or output (to ${back.join(", ")}), not on a failure, so none of them is ${id}'s way back; name where a failure of ${id} goes with fix="<station>"`);
      if (back.length > 1) throw new Error(`${what}: ${anchor} fails back to ${back.join(" or ")}, so it is not clear where ${id}'s failure goes; name one with fix="${back[0]}"`);
      fix = back[0] ?? null;
    }
    let on: string;
    if (anchorKey === "after") {
      const from = lastAfter.get(anchor) ?? anchor;
      on = onePassTarget(from, what);
      const pass = new Set(passingOut(from));
      edges = edges.map((e) => (pass.has(e) ? { ...e, to: id } : e));
      lastAfter.set(anchor, id);
    } else {
      on = anchor;
      edges = edges.map((e) => (e.to === anchor ? { ...e, to: id } : e));
    }
    // A person's gate offers its choices as labelled edges (runner.ts executeRemoteHumanGate): go on, or send it back.
    const gate = shapeOf(a) === "hexagon";
    const name = String(a.label ?? id);
    const labelOf = (x: string) => String(nodes.get(x)?.label ?? x.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()));
    if (gate) edges.push({ from: id, to: on, label: `[Y] Go on :: ${labelOf(on)}` });
    else edges.push({ from: id, to: on, condition: "outcome = success" });
    if (fix && gate) edges.push({ from: id, to: fix, label: `[N] Send back :: ${labelOf(fix)}` });
    else if (fix) edges.push({ from: id, to: fix, condition: "outcome = failure", label: `${name.toLowerCase()} failed` });
    edits.push({ op: "add", station: id, label: name, [anchorKey]: anchor, ...(a.fix !== undefined ? { fix: String(a.fix) } : {}), ...(!fix ? { ends_on_failure: true as const } : {}) });
  }

  // Path conditions last, around the station where it now stands.
  const gated: Record<string, string[]> = { ...(raw.gated ?? {}) };
  for (const [id, a] of own) {
    if (a.when === undefined) continue;
    const paths = whenPaths(String(a.when));
    const what = say(id, "when", a.when);
    if (!paths.length) throw new Error(`${what}: name the paths the change must touch (when="src/**, docs/*.md")`);
    if (!nodes.has(id)) throw new Error(`${what}: ${baseName} has no station ${id}; its stations: ${stations()}`);
    const takes = String(raw.attrs.takes ?? "task").split(/[\s,]+/).filter(Boolean);
    if (!takes.includes("branch")) throw new Error(`${what}: ${baseName} runs on a ${takes.join(" and a ")}, not on a change's files, so nothing tells it which paths changed; when= works on flows that take a branch (change, quick-change)`);
    notInFan(id, what, "gating it");
    const to = onePassTarget(id, what);
    const touches = `change_files touches ${JSON.stringify(paths.join(", "))}`;
    const into = edges.filter((e) => e.to === id && e.from !== id);
    if (!into.length) throw new Error(`${what}: nothing leads into ${id}, so there is no way past it`);
    edges = edges.flatMap((e) => (e.to === id && e.from !== id ? [{ ...e, condition: andCondition(e.condition, touches) }, { from: e.from, to, condition: andCondition(e.condition, `not ${touches}`) }] : [e]));
    edits.push({ op: "when", station: id, paths });
    gated[id] = paths;
  }

  for (const a of nodes.values()) for (const k of VARIANT_KEYS) if (k !== "guide") delete a[k];
  for (const id of Object.keys(gated)) if (pruned.includes(id) || !nodes.has(id)) delete gated[id];
  return { ...raw, nodes, edges, fills, overrides, edits, pruned: [...(raw.pruned ?? []), ...pruned], gated };
}

/** A variant's attributes for stations inside its segments, applied once they are expanded (an override of a station that is not there is refused). */
export function applyOverrides(raw: RawGraph): RawGraph {
  if (!raw.overrides?.size) return raw;
  const nodes = new Map(raw.nodes);
  const stepsOf = (top: string) => [...nodes.keys()].filter((id) => id.startsWith(`${top}${SEGMENT_SEP}`) && !nodes.get(id)!.segment_exit);
  for (const [key, attrs] of raw.overrides) {
    let id = key;
    if (!key.includes(SEGMENT_SEP)) {
      const prompted = stepsOf(key).filter((s) => typeof nodes.get(s)!.prompt === "string" && shapeOf(nodes.get(s)!) !== "parallelogram");
      const k = attrs.guide !== undefined ? "guide" : "prompt";
      if (prompted.length !== 1) {
        throw new Error(prompted.length
          ? `${raw.name}: ${key} [${k}=...]: ${key} has ${prompted.length} stations that read a prompt (${prompted.join(", ")}); name one: ${prompted[0]} [${k}=...]`
          : `${raw.name}: ${key} [${k}=...]: no station of ${key} reads a prompt (its steps: ${stepsOf(key).join(", ") || "none"}); ${k}= changes an agent's prompt`);
      }
      id = prompted[0];
    }
    const at = nodes.get(id);
    if (!at) {
      const top = key.split(SEGMENT_SEP)[0];
      const steps = stepsOf(top);
      throw new Error(steps.length
        ? `${raw.name}: ${key} [...] changes a station of the ${top} segment, which has no ${key.slice(top.length + SEGMENT_SEP.length)}; its stations: ${steps.join(", ")}`
        : `${raw.name}: ${key} [...] changes a station inside a segment, but ${top} is not a segment of this flow`);
    }
    nodes.set(id, { ...at, ...attrs });
  }
  return { ...raw, nodes, overrides: undefined };
}

/** `guide=` appended to the prompt it inherits; without inlining (where each station's file lives) the prompt stays its base's file. */
export function withGuides(raw: RawGraph, read: ReadFile | null, sources: Set<string>): Array<{ node: string; text: string | null }> {
  const out: Array<{ node: string; text: string | null }> = [];
  for (const [id, a] of raw.nodes) {
    if (a.guide === undefined) continue;
    const guide = String(a.guide);
    delete a.guide;
    if (shapeOf(a) === "hexagon") throw new Error(`${raw.name}: ${id} [guide=...]: ${id} is a person's question, not an agent's prompt; guide= adds to what an agent reads`);
    if (typeof a.prompt !== "string" || !a.prompt) throw new Error(`${raw.name}: ${id} [guide=...] adds to a prompt, and ${id} has none; write prompt= instead`);
    if (!read) { out.push({ node: id, text: null }); continue; }
    const text = inlineRef(guide, read, sources).replace(/\s+$/, "");
    a.prompt = `${inlineRef(a.prompt, read, sources).replace(/\s+$/, "")}\n\n${text}`;
    out.push({ node: id, text });
  }
  return out;
}
