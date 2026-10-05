// Every Evals address, both ways: parseEvalsPath reads a location into the view
// it names, and evalsHref builds every link. The area registers one route
// family (/evals and /evals/*), so this file is the only place that knows the
// sub-paths. Pure: no React, no store.
//
// An address is stored by the tab system, which persists to IndexedDB and
// syncs to Convex, so it carries identifiers only (evals-ui.md section 1):
// a surface, a freeze id's first 8 characters (the api resolves the prefix),
// run ids (surface, freeze prefix, seed and stamp), a stamp, a sha, a bisect
// id. A batch with any other name rides as its hash (evalsBatchRef), which
// each page resolves against the batches it loaded. evalsCanonicalPath brings
// any typed or older address to that form.

import { EVALS_SHA_RE, evalsBatchRef } from "@codecast/shared/contracts/evalsApi";

export type EvalsView =
  | { view: "home"; cadence: string | null }
  | { view: "surface"; surface: string; batch: string | null; compare: string | null }
  | { view: "freeze"; freezeId: string; batch: string | null; a: string | null; b: string | null }
  | { view: "run"; runId: string }
  | { view: "compare"; a: string; b: string }
  | { view: "bisect-list" }
  | { view: "bisect-new"; surface: string | null; good: string | null; bad: string | null; freeze: string | null; all?: boolean }
  | { view: "bisect"; id: string }
  | { view: "sim" }
  | { view: "sim-run"; session: string; run: string }
  | { view: "commit"; sha: string; surface: string | null }
  | { view: "patch"; sha: string }
  | { view: "not-found"; path: string };

export type EvalsViewName = EvalsView["view"];

const enc = encodeURIComponent;

/** How an address names a freeze: its id's first 8 characters, which the api resolves to the freeze. */
export const FREEZE_REF_LENGTH = 8;
export const freezeRef = (freezeId: string): string => freezeId.slice(0, FREEZE_REF_LENGTH);
/** A freeze param that names a freeze (bisect/new?freeze=): its prefix. */
const freezeParam = (f: string | null | undefined): string | null => (f ? freezeRef(f) : null);

function dec(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

function withQuery(path: string, query: Record<string, string | null | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) qs.set(k, v);
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/** Every link into the area. */
export const evalsHref = {
  home: (opts: { cadence?: string | null } = {}) => withQuery("/evals", { cadence: opts.cadence }),
  surface: (surface: string, opts: { batch?: string | null; compare?: string | null } = {}) => withQuery(`/evals/s/${enc(surface)}`, { batch: evalsBatchRef(opts.batch), compare: evalsBatchRef(opts.compare) }),
  /** `a` and `b` open the freeze with those two runs on its cards, not its own default pair. */
  freeze: (freezeId: string, opts: { batch?: string | null; a?: string | null; b?: string | null } = {}) => withQuery(`/evals/f/${enc(freezeRef(freezeId))}`, { batch: evalsBatchRef(opts.batch), a: opts.a, b: opts.b }),
  /** `anchor` is a gate or check fragment: `gate-no-leak`, `check-criteria`. */
  run: (runId: string, anchor?: string) => `/evals/r/${enc(runId)}${anchor ? `#${anchor}` : ""}`,
  compare: (a: string, b: string) => withQuery("/evals/compare", { a, b }),
  bisectList: () => "/evals/bisect",
  /** `all` searches every commit in the range, not only those touching declared sources (--all-commits). */
  bisectNew: (opts: { surface?: string | null; good?: string | null; bad?: string | null; freeze?: string | null; all?: boolean } = {}) =>
    withQuery("/evals/bisect/new", { surface: opts.surface, good: evalsBatchRef(opts.good), bad: evalsBatchRef(opts.bad), freeze: freezeParam(opts.freeze), all: opts.all ? "1" : null }),
  bisect: (id: string) => `/evals/bisect/${enc(id)}`,
  sim: () => "/evals/sim",
  simRun: (session: string, run: string) => `/evals/sim/${enc(session)}/${enc(run)}`,
  /** One commit, its diff limited to the surface's declared sources when a surface is named. */
  commit: (sha: string, opts: { surface?: string | null } = {}) => withQuery(`/evals/c/${enc(sha)}`, { surface: opts.surface }),
  /** One kept tree patch: the uncommitted edits a dirty rep ran on. */
  patch: (sha: string) => `/evals/p/${enc(sha)}`,
};

/**
 * Where the Line page's Sense row for the evals finder opens: the surface its
 * newest signal names (a signal's subject is its surface), else the wall.
 */
export function evalsSenseHref(subject: string | null | undefined): string {
  return subject && /^[a-z][a-z0-9-]*$/.test(subject) ? evalsHref.surface(subject) : evalsHref.home();
}

/** The href a view is at: the inverse of parseEvalsPath. */
export function evalsHrefFor(v: EvalsView): string {
  switch (v.view) {
    case "home":
      return evalsHref.home({ cadence: v.cadence });
    case "surface":
      return evalsHref.surface(v.surface, { batch: v.batch, compare: v.compare });
    case "freeze":
      return evalsHref.freeze(v.freezeId, { batch: v.batch, a: v.a, b: v.b });
    case "run":
      return evalsHref.run(v.runId);
    case "compare":
      return evalsHref.compare(v.a, v.b);
    case "bisect-list":
      return evalsHref.bisectList();
    case "bisect-new":
      return evalsHref.bisectNew(v);
    case "bisect":
      return evalsHref.bisect(v.id);
    case "sim":
      return evalsHref.sim();
    case "sim-run":
      return evalsHref.simRun(v.session, v.run);
    case "commit":
      return evalsHref.commit(v.sha, { surface: v.surface });
    case "patch":
      return evalsHref.patch(v.sha);
    case "not-found":
      return v.path;
  }
}

/** The view a location names. Anything under /evals that names no view is `not-found`, never a guess. */
export function parseEvalsPath(pathname: string, search: string | URLSearchParams = ""): EvalsView {
  const path = pathname.split("#")[0].split("?")[0];
  const q = typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search;
  const get = (k: string) => q.get(k) || null;
  const raw = path.replace(/\/+$/, "").split("/").slice(1);
  if (raw[0] !== "evals") return { view: "not-found", path: pathname };
  const segs = raw.slice(1).map(dec);
  const miss = { view: "not-found", path: pathname } as const;
  if (segs.some((s) => s === null || s === "")) return miss;
  const [a, b, c] = segs as string[];
  switch (segs.length) {
    case 0:
      return { view: "home", cadence: get("cadence") };
    case 1:
      if (a === "compare") {
        const x = get("a");
        const y = get("b");
        return x && y ? { view: "compare", a: x, b: y } : miss;
      }
      if (a === "bisect") return { view: "bisect-list" };
      if (a === "sim") return { view: "sim" };
      return miss;
    case 2:
      if (a === "s") return { view: "surface", surface: b, batch: get("batch"), compare: get("compare") };
      if (a === "f") return { view: "freeze", freezeId: b, batch: get("batch"), a: get("a"), b: get("b") };
      if (a === "c") return { view: "commit", sha: b, surface: get("surface") };
      if (a === "p") return { view: "patch", sha: b };
      if (a === "r") return { view: "run", runId: b };
      if (a === "bisect" && b === "new") return { view: "bisect-new", surface: get("surface"), good: get("good"), bad: get("bad"), freeze: get("freeze"), ...(get("all") === "1" ? { all: true } : {}) };
      if (a === "bisect") return { view: "bisect", id: b };
      return miss;
    case 3:
      if (a === "sim") return { view: "sim-run", session: b, run: c };
      return miss;
    default:
      return miss;
  }
}

const SURFACE_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const BISECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const FOLDER_RE = /^[A-Za-z0-9._-]{1,160}$/;
const HEX_RE = /^[0-9a-f]{4,64}$/;
const FREEZE_ID_RE = /^[0-9a-f-]{4,36}$/;
const CADENCES_RE = /^[a-z]{1,24}$/;
const FRAGMENT_RE = /^[a-z0-9-]{1,80}$/i;

/** A view whose every part is an identifier the tab list may keep, or null when one part is not. */
function identifiersOnly(v: EvalsView): EvalsView | null {
  const surface = (x: string | null) => x === null || SURFACE_ID_RE.test(x);
  const run = (x: string | null) => x === null || RUN_ID_RE.test(x);
  switch (v.view) {
    case "home":
      return { ...v, cadence: v.cadence && CADENCES_RE.test(v.cadence) ? v.cadence : null };
    case "surface":
      return surface(v.surface) ? v : null;
    case "freeze":
      return FREEZE_ID_RE.test(v.freezeId) && run(v.a) && run(v.b) ? v : null;
    case "run":
      return run(v.runId) ? v : null;
    case "compare":
      return run(v.a) && run(v.b) ? v : null;
    case "bisect-new":
      return surface(v.surface) && (v.freeze === null || FREEZE_ID_RE.test(v.freeze)) ? v : null;
    case "bisect":
      return BISECT_ID_RE.test(v.id) ? v : null;
    case "sim-run":
      return FOLDER_RE.test(v.session) && FOLDER_RE.test(v.run) ? v : null;
    case "commit":
    case "patch":
      return HEX_RE.test(v.sha) && (v.view === "patch" || surface(v.surface)) ? v : null;
    case "bisect-list":
    case "sim":
      return v;
    case "not-found":
      return null;
  }
}

/**
 * The address the tab system keeps for an Evals path: the same view, spelled
 * with identifiers only. A full freeze id becomes its prefix and a named
 * batch its hash; a path that names no view, or names one through anything
 * but an identifier, becomes the wall. A fragment (a gate or a tab) stays
 * when it is a plain word.
 */
export function evalsCanonicalPath(path: string): string {
  const [beforeHash, fragment = ""] = path.split("#");
  const [pathname, query = ""] = beforeHash.split("?");
  const v = identifiersOnly(parseEvalsPath(pathname, query));
  if (!v) return evalsHref.home();
  const href = evalsHrefFor(v);
  return FRAGMENT_RE.test(fragment) ? `${href}#${fragment}` : href;
}

/** Whether a path is an Evals address. */
export const isEvalsPath = (path: string): boolean => /^\/evals(?:[/?#]|$)/.test(path);

/** The tab of the area's local nav a view belongs to. */
export function evalsSection(v: EvalsView): "surfaces" | "bisects" | "sim" | null {
  switch (v.view) {
    case "bisect-list":
    case "bisect-new":
    case "bisect":
      return "bisects";
    case "sim":
    case "sim-run":
      return "sim";
    case "not-found":
      return null;
    default:
      return "surfaces";
  }
}

/** The tab title for an Evals address: what the view is about, not its path. */
export function evalsTabLabel(path: string): string {
  const [pathname, query = ""] = path.split("#")[0].split("?");
  const v = parseEvalsPath(pathname, query);
  switch (v.view) {
    case "home":
    case "not-found":
      return "Evals";
    case "surface":
      return v.surface;
    case "freeze":
      return `Freeze ${v.freezeId.slice(0, 8)}`;
    case "run": {
      const m = v.runId.match(/^(.+?)-[0-9a-f]{8}-seed(\d+)-/);
      return m ? `${m[1]} seed ${m[2]}` : "Run";
    }
    case "compare":
      return "Compare runs";
    case "bisect-list":
      return "Bisects";
    case "bisect-new":
      return v.surface ? `Attribute ${v.surface}` : "Attribute";
    case "bisect":
      return `Bisect ${v.id}`;
    case "sim":
      return "Multiplayer sim";
    case "sim-run":
      return v.run;
    case "commit":
      return `Commit ${v.sha.slice(0, 8)}`;
    case "patch":
      return `Patch ${v.sha.slice(0, 8)}`;
  }
}

// ── The search box ──────────────────────────────────────────────────────────

/**
 * What the search box knows: the wall's surfaces and their batches, the
 * freezes a page loaded, and what `GET /search` found in the index for the
 * text typed (freezes and runs by id prefix).
 */
export interface EvalsSearchKnown {
  surfaces: string[];
  /** Batch name to the surfaces that ran it. */
  batches: Record<string, string[]>;
  freezes: Array<{ id: string; name: string }>;
  runs?: Array<{ id: string; surface: string; freezeName: string | null }>;
}

export interface EvalsSearchTarget {
  kind: "surface" | "run" | "batch" | "freeze" | "commit";
  label: string;
  href: string;
}

const RUN_ID_RE = /^([a-z][a-z0-9-]*?)-([0-9a-f]{8})-seed(\d+)-\d{4}-\d{2}-\d{2}T[\d-]+Z$/;
const BATCH_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Where a search can go, best first. It accepts a surface id, a run id or its
 * prefix, a batch name, a freeze id prefix and a sha. A hex string that names
 * no known freeze reads as a commit, which opens its commit page.
 */
export function evalsSearchTargets(input: string, known: EvalsSearchKnown): EvalsSearchTarget[] {
  const q = input.trim();
  if (!q) return [];
  const lower = q.toLowerCase();
  const out: EvalsSearchTarget[] = [];
  for (const s of known.surfaces) {
    if (s === lower) out.unshift({ kind: "surface", label: s, href: evalsHref.surface(s) });
    else if (s.startsWith(lower) || s.includes(lower)) out.push({ kind: "surface", label: s, href: evalsHref.surface(s) });
  }
  if (RUN_ID_RE.test(q)) out.push({ kind: "run", label: q, href: evalsHref.run(q) });
  for (const r of known.runs ?? []) if (r.id !== q && r.id.toLowerCase().startsWith(lower)) out.push({ kind: "run", label: r.id, href: evalsHref.run(r.id) });
  if (BATCH_RE.test(q)) {
    const surfaces = known.batches[q] ?? [];
    for (const s of surfaces) out.push({ kind: "batch", label: `${s} at batch ${q}`, href: evalsHref.surface(s, { batch: q }) });
  }
  if (lower.length >= 3) {
    for (const f of known.freezes) if (f.id.toLowerCase().startsWith(lower)) out.push({ kind: "freeze", label: `${f.name} (${f.id.slice(0, 8)})`, href: evalsHref.freeze(f.id) });
  }
  if (EVALS_SHA_RE.test(lower) && !out.some((t) => t.kind === "freeze")) out.push({ kind: "commit", label: `commit ${lower.slice(0, 12)}`, href: evalsHref.commit(lower) });
  return out.slice(0, 8);
}
