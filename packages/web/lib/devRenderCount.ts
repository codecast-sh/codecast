// Dev-only render diagnostics.
//
//   devRenderCount("ConversationView2");   // at the top of a component body
//   devCountElements("ConversationView2", el); // on the element tree a body returns
//
// Read `__renderCounts()` / `__elementCounts()` in the console (pass `true` to
// reset). Render counts are EXECUTIONS of the body, including render-phase
// re-runs React never commits (renderWithHooksAgain), which the profiler's
// commit-based counters miss. Element counts size the tree one pass builds,
// with a breakdown of the biggest child chunks, so a whale in a large return
// can be found without reading it.
declare const process: { env: { NODE_ENV?: string } };

const counts: Record<string, number> = {};
const elements: Record<string, { passes: number; last: number; max: number; ms: number; maxMs: number; tree: unknown }> = {};

export function devRenderCount(name: string): void {
  if (process.env.NODE_ENV === "production") return;
  counts[name] = (counts[name] || 0) + 1;
}

type Summary = { name: string; size: number; children?: Summary[] };

function isElement(n: any): boolean {
  return !!n && typeof n === "object" && !!n.$$typeof;
}
function typeName(n: any): string {
  const t = n.type;
  if (typeof t === "string") return t;
  if (typeof t === "symbol") return String(t).replace(/^Symbol\(react\.(.*)\)$/, "$1");
  if (typeof t === "function") return t.displayName || t.name || "anon";
  if (t && typeof t === "object") return t.displayName || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name || "obj";
  return "?";
}
// Total elements reachable from a node through arrays and element-valued props
// (children, headerExtra, icon...). Plain data objects are not descended.
function sizeOf(n: any): number {
  if (!n) return 0;
  if (Array.isArray(n)) { let t = 0; for (const c of n) t += sizeOf(c); return t; }
  if (!isElement(n)) return 0;
  let t = 1;
  const p = n.props;
  if (p) for (const k in p) { const v = p[k]; if (v && typeof v === "object") t += sizeOf(v); }
  return t;
}
function childrenOf(n: any): any[] {
  const out: any[] = [];
  const p = n.props;
  if (!p) return out;
  for (const k in p) {
    const v = p[k];
    if (Array.isArray(v)) { for (const c of v.flat(3)) if (isElement(c)) out.push(c); }
    else if (isElement(v)) out.push(v);
  }
  return out;
}
function summarize(n: any, depth: number, minSize: number): Summary {
  const size = sizeOf(n);
  const s: Summary = { name: typeName(n), size };
  if (depth > 0 && size > minSize) {
    const kids = childrenOf(n).map((c) => summarize(c, depth - 1, minSize)).filter((c) => c.size > minSize).sort((a, b) => b.size - a.size).slice(0, 8);
    if (kids.length) s.children = kids;
  }
  return s;
}

// Section timing inside one body: call devSection("CV.hooksA") at statement
// boundaries; each call charges the time since the previous mark (or the pass
// start set by devPassStart) to that section. Read via __timings().
let _sectionMark = 0;
export function devPassStart(): void { if (process.env.NODE_ENV !== "production") _sectionMark = performance.now(); }
export function devSection(name: string): void {
  if (process.env.NODE_ENV === "production") return;
  const now = performance.now();
  const t = timings[name] || (timings[name] = { calls: 0, ms: 0 });
  t.calls++; t.ms += now - _sectionMark; _sectionMark = now;
}

export function devCountElements(name: string, el: unknown, ms = 0): void {
  if (process.env.NODE_ENV === "production") return;
  const size = sizeOf(el);
  const e = elements[name] || (elements[name] = { passes: 0, last: 0, max: 0, ms: 0, maxMs: 0, tree: null });
  e.passes++; e.last = size; e.ms += ms; if (ms > e.maxMs) e.maxMs = ms;
  if (size >= e.max) { e.max = size; e.tree = isElement(el) ? summarize(el, 5, 40) : null; }
}

const timings: Record<string, { calls: number; ms: number }> = {};
// Wrap a hot helper: devTimed("renderItem", fn) accumulates its wall time;
// read `__timings()` in the console. Zero-cost passthrough in production.
export function devTimed<F extends (...a: any[]) => any>(name: string, fn: F): F {
  if (process.env.NODE_ENV === "production") return fn;
  return ((...a: any[]) => {
    const t0 = performance.now();
    try { return fn(...a); } finally {
      const t = timings[name] || (timings[name] = { calls: 0, ms: 0 });
      t.calls++; t.ms += performance.now() - t0;
    }
  }) as F;
}

if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
  (window as any).__timings = (reset?: boolean) => {
    const out = JSON.parse(JSON.stringify(timings));
    if (reset) for (const k in timings) delete timings[k];
    return out;
  };
  (window as any).__renderCounts = (reset?: boolean) => {
    const out = { ...counts };
    if (reset) for (const k in counts) delete counts[k];
    return out;
  };
  (window as any).__elementCounts = (reset?: boolean) => {
    const out = JSON.parse(JSON.stringify(elements));
    if (reset) for (const k in elements) delete elements[k];
    return out;
  };
}
