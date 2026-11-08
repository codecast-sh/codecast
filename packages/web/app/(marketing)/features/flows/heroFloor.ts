/*
 * The hero's floor plan as data. One schedule of runs on a shared loop of L
 * seconds is laid onto a Plan: the wide layout (desktop) or the tall one
 * (phone and tablet). The same schedule drives the SMIL motion, the still
 * frame (each token's position at T0), the step highlights (who is inside
 * which step), the slot fills and the counters, so what moves and what is
 * counted can never disagree, and both layouts run the same story.
 */

export type Pt = readonly [number, number];
export type Box = { x: number; y: number; w: number; h: number };
export type Anchor = "start" | "middle" | "end";
export type TextAt = { x: number; y: number; anchor?: Anchor };

/** Seconds in one loop of the floor. */
export const L = 32;
/** The moment the still frame shows (picked with the probe in /tmp/flows-dive). */
export const T0 = 25;

export const STEP_IDS = ["check", "review", "decide", "land", "deploy", "live"] as const;
export type NodeId = (typeof STEP_IDS)[number];
export const STEP_LABEL: Record<NodeId, string> = { check: "Check", review: "Review", decide: "Decide", land: "Land", deploy: "Deploy", live: "Live" };

// ---------- routes ----------
type Sample = { x: number; y: number; s: number };
export type Route = { d: string; samples: Sample[]; len: number };

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A polyline with rounded corners, sampled for length and nearest-point lookups. */
export function route(points: readonly Pt[], radius = 9): Route {
  const p = points.filter((q, i) => i === 0 || q[0] !== points[i - 1][0] || q[1] !== points[i - 1][1]);
  const samples: Sample[] = [{ x: p[0][0], y: p[0][1], s: 0 }];
  const push = (x: number, y: number) => {
    const last = samples[samples.length - 1];
    samples.push({ x, y, s: last.s + Math.hypot(x - last.x, y - last.y) });
  };
  let d = `M${r1(p[0][0])} ${r1(p[0][1])}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [a, b, c] = [p[i - 1], p[i], p[i + 1]];
    const lin = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const lout = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const r = Math.min(radius, lin / 2, lout / 2);
    const s0: Pt = [b[0] - ((b[0] - a[0]) / lin) * r, b[1] - ((b[1] - a[1]) / lin) * r];
    const s1: Pt = [b[0] + ((c[0] - b[0]) / lout) * r, b[1] + ((c[1] - b[1]) / lout) * r];
    d += ` L${r1(s0[0])} ${r1(s0[1])} Q${r1(b[0])} ${r1(b[1])} ${r1(s1[0])} ${r1(s1[1])}`;
    push(s0[0], s0[1]);
    for (let k = 1; k <= 6; k++) {
      const t = k / 6;
      const u = 1 - t;
      push(u * u * s0[0] + 2 * u * t * b[0] + t * t * s1[0], u * u * s0[1] + 2 * u * t * b[1] + t * t * s1[1]);
    }
  }
  const end = p[p.length - 1];
  d += ` L${r1(end[0])} ${r1(end[1])}`;
  push(end[0], end[1]);
  return { d, samples, len: samples[samples.length - 1].s };
}

/** Fraction of the route's length at the point on it nearest `q`. */
export function fracOf(r: Route, q: Pt): number {
  let best = Infinity;
  let bestS = 0;
  for (let i = 1; i < r.samples.length; i++) {
    const a = r.samples[i - 1];
    const b = r.samples[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((q[0] - a.x) * dx + (q[1] - a.y) * dy) / l2));
    const dist = Math.hypot(a.x + dx * t - q[0], a.y + dy * t - q[1]);
    if (dist < best - 1e-6) {
      best = dist;
      bestS = a.s + (b.s - a.s) * t;
    }
  }
  return r.len === 0 ? 0 : bestS / r.len;
}

/** The point at a fraction of the route's length. */
export function pointAt(r: Route, f: number): Pt {
  const s = Math.max(0, Math.min(1, f)) * r.len;
  for (let i = 1; i < r.samples.length; i++) {
    const a = r.samples[i - 1];
    const b = r.samples[i];
    if (s <= b.s || i === r.samples.length - 1) {
      const t = b.s === a.s ? 0 : (s - a.s) / (b.s - a.s);
      return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
    }
  }
  return [r.samples[0].x, r.samples[0].y];
}

// ---------- a layout ----------
/** Where everything sits in one layout, and the paths tokens take through it. */
export type Plan = {
  W: number;
  H: number;
  stages: { n: number; name: string; x0: number; x1: number; y: number }[];
  signalsToday: { num: TextAt; size: number; label: TextAt };
  sources: { box: Box; name: TextAt; spark: Pt; status: TextAt; port: Pt }[];
  triage: { box: Box; title: TextAt | null; rows: { box: Box; kind: TextAt; count: TextAt }[]; chips: Pt[]; queued: TextAt; queueHit: Box };
  line: { box: Box; title: TextAt; count: TextAt; slots: Box[]; glyph: Pt | null };
  session: { box: Box; glyph: Pt; title: TextAt; sub: TextAt };
  steps: Record<NodeId, Box>;
  watch: { box: Box; title: TextAt; days: TextAt; count: TextAt };
  clean: Box;
  labels: {
    onPerson: TextAt;
    liveToday: TextAt;
    sameChecks: TextAt | null;
    back: TextAt;
    fix: TextAt & { chip: boolean };
    revise: TextAt & { chip: boolean };
  };
  legend: { cols: number[]; rows: number[] };
  edges: { signals: string[]; silent: string[]; line: string[]; person: string; main: string };
  // the paths and the stops along them
  signalRoute: (src: number, bar: number) => Route;
  signalFrom: (src: number) => Pt;
  signalTarget: (bar: number) => Pt;
  lineRoute: (k: number) => Route;
  q0: Pt;
  slotIn: (k: number) => Pt;
  slotOut: (k: number) => Pt;
  personRoute: Route;
  sessionAt: Pt;
  checkEdge: Pt;
  at: (n: NodeId | "watch" | "clean") => Pt;
  fixRoute: Route;
  reviseRoute: Route;
  regressRoute: Route;
};

const centre = (b: Box): Pt => [b.x + b.w / 2, b.y + b.h / 2];
const memo = <A extends unknown[], R>(f: (...a: A) => R) => {
  const m = new Map<string, R>();
  return (...a: A) => {
    const k = a.join(",");
    let v = m.get(k);
    if (v === undefined) m.set(k, (v = f(...a)));
    return v;
  };
};

/** The wide layout: the whole loop left to right, as the app's Loop reads. */
function widePlan(): Plan {
  const W = 1280;
  const H = 540;
  const ROW = 250;
  const RAIL = 588;
  const SOURCE_Y = [136, 182, 228, 274, 320];
  const BUS = 184;
  const BAR_Y = [291, 310, 329];
  const BAR_X = 212;
  const QUEUE_Y = 352;
  const SLOT_Y = [334, 355, 376, 397];
  const SLOT_X0 = 396;
  const SLOT_X1 = 552;
  const SESSION_Y = 150;
  const steps: Record<NodeId, Box> = {
    check: { x: 610, y: ROW - 20, w: 80, h: 40 },
    review: { x: 712, y: ROW - 20, w: 80, h: 40 },
    decide: { x: 814, y: ROW - 20, w: 80, h: 40 },
    land: { x: 938, y: ROW - 20, w: 80, h: 40 },
    deploy: { x: 1040, y: ROW - 20, w: 80, h: 40 },
    live: { x: 1140, y: ROW - 20, w: 64, h: 40 },
  };
  const LIVE_X = 1172;
  const watch: Box = { x: 1104, y: 302, w: 136, h: 68 };
  const clean: Box = { x: 1118, y: 402, w: 108, h: 26 };
  const WATCH_C: Pt = [LIVE_X, watch.y + watch.h / 2];
  const CLEAN_C: Pt = [LIVE_X, clean.y + clean.h / 2];
  const ARC_Y = 506;
  const checkEdge: Pt = [steps.check.x, ROW];
  const mainTail: Pt[] = [checkEdge, [LIVE_X, ROW], CLEAN_C];
  const q0: Pt = [292, QUEUE_Y];
  const signalTarget = (bar: number): Pt => (bar < 0 ? [222, QUEUE_Y] : [BAR_X, BAR_Y[bar]]);
  const signalFrom = (src: number): Pt => [168, SOURCE_Y[src]];
  const signalPts = (src: number, bar: number): Pt[] => {
    const t = signalTarget(bar);
    return [signalFrom(src), [BUS, SOURCE_Y[src]], [BUS, t[1]], t];
  };
  const lineToCheck = (k: number): Pt[] => [q0, [366, QUEUE_Y], [366, SLOT_Y[k]], [SLOT_X0 + 10, SLOT_Y[k]], [RAIL, SLOT_Y[k]], [RAIL, ROW], checkEdge];
  const sessionAt: Pt = [552, SESSION_Y];
  const sessionToCheck: Pt[] = [sessionAt, [RAIL, SESSION_Y], [RAIL, ROW], checkEdge];
  const at = (n: NodeId | "watch" | "clean"): Pt => (n === "watch" ? WATCH_C : n === "clean" ? CLEAN_C : [centre(steps[n])[0], ROW]);
  const used: [number, number][] = [[0, 0], [0, 1], [0, 2], [0, -1], [1, 1], [1, 2], [1, 0], [2, 0], [2, 2], [2, 1]];
  return {
    W,
    H,
    stages: [
      { n: 1, name: "Signals", x0: 20, x1: 168, y: 28 },
      { n: 2, name: "Triage", x0: 200, x1: 346, y: 28 },
      { n: 3, name: "Build", x0: 380, x1: 566, y: 28 },
      { n: 4, name: "Checks", x0: steps.check.x, x1: steps.decide.x + steps.decide.w, y: 28 },
      { n: 5, name: "Ship and watch", x0: steps.land.x, x1: watch.x + watch.w, y: 28 },
    ],
    signalsToday: { num: { x: 20, y: 80 }, size: 24, label: { x: 20, y: 99 } },
    sources: SOURCE_Y.map((y) => ({
      box: { x: 20, y: y - 19, w: 148, h: 38 },
      name: { x: 32, y: y - 3 },
      spark: [32, y + 12] as Pt,
      status: { x: 156, y: y + 13, anchor: "end" as const },
      port: [168, y] as Pt,
    })),
    triage: {
      box: { x: 200, y: 256, w: 146, h: 136 },
      title: { x: 212, y: 276 },
      rows: BAR_Y.map((y) => ({ box: { x: 210, y: y - 8.5, w: 126, h: 17 }, kind: { x: 220, y: y + 4 }, count: { x: 330, y: y + 4, anchor: "end" as const } })),
      chips: [0, 1, 2, 3, 4].map((i) => [230 + i * 11, QUEUE_Y] as Pt),
      queued: { x: 212, y: 380 },
      queueHit: { x: 222, y: QUEUE_Y - 8, w: 76, h: 16 },
    },
    line: {
      box: { x: 380, y: 290, w: 186, h: 126 },
      title: { x: 412, y: 312 },
      count: { x: 552, y: 312, anchor: "end" },
      slots: SLOT_Y.map((y) => ({ x: SLOT_X0, y: y - 9, w: SLOT_X1 - SLOT_X0, h: 18 })),
      glyph: [400, 308],
    },
    session: { box: { x: 380, y: SESSION_Y - 28, w: 186, h: 56 }, glyph: [398, SESSION_Y - 7], title: { x: 410, y: SESSION_Y - 3 }, sub: { x: 410, y: SESSION_Y + 16 } },
    steps,
    watch: { box: watch, title: { x: watch.x + 12, y: watch.y + 24 }, days: { x: watch.x + watch.w - 12, y: watch.y + 24, anchor: "end" }, count: { x: watch.x + 12, y: watch.y + 50 } },
    clean,
    labels: {
      onPerson: { x: steps.decide.x + 18, y: ROW + 43 },
      liveToday: { x: LIVE_X - 10, y: ROW + 41, anchor: "end" },
      sameChecks: { x: steps.check.x, y: ROW + 43 },
      back: { x: 204, y: 529 },
      fix: { x: 560, y: 96, anchor: "middle", chip: true },
      revise: { x: 742, y: 72, anchor: "middle", chip: true },
    },
    legend: { cols: [610, 806], rows: [418, 442, 466] },
    edges: {
      signals: used.filter(([s]) => s < 3).map(([s, b]) => route(signalPts(s, b)).d),
      silent: [route(signalPts(3, 1)).d, route(signalPts(4, 2)).d],
      line: SLOT_Y.map((_, k) => route(lineToCheck(k)).d),
      person: route(sessionToCheck).d,
      main: route(mainTail).d,
    },
    signalRoute: memo((src: number, bar: number) => route(signalPts(src, bar))),
    signalFrom,
    signalTarget,
    lineRoute: memo((k: number) => route([...lineToCheck(k), ...mainTail.slice(1)])),
    q0,
    slotIn: (k) => [SLOT_X0 + 10, SLOT_Y[k]],
    slotOut: (k) => [SLOT_X1 - 10, SLOT_Y[k]],
    personRoute: route([...sessionToCheck, ...mainTail.slice(1)]),
    sessionAt,
    checkEdge,
    at,
    fixRoute: route([at("check"), [at("check")[0], 96], [470, 96], [470, SESSION_Y]]),
    reviseRoute: route([at("decide"), [at("decide")[0], 72], [430, 72], [430, SESSION_Y]]),
    regressRoute: route([WATCH_C, [1084, WATCH_C[1]], [1084, ARC_Y], [BUS, ARC_Y], [BUS, BAR_Y[1]], [BAR_X, BAR_Y[1]]]),
  };
}

/** The tall layout: the same loop top to bottom, for phones and tablets. */
function tallPlan(): Plan {
  const W = 372;
  const H = 1062;
  const SOURCE_Y = [80, 110, 140, 170, 200];
  const BUS = 340;
  const BAR_Y = [272, 292, 312];
  const QUEUE_Y = 336;
  const SLOT_Y = [430, 448, 466, 484];
  const SLOT_X0 = 202;
  const SLOT_X1 = 338;
  const COL = 180;
  const MERGE_Y = 520;
  const stepAt = (y: number, w = 150): Box => ({ x: COL - w / 2, y: y - 18, w, h: 36 });
  const steps: Record<NodeId, Box> = {
    check: stepAt(556),
    review: stepAt(604),
    decide: stepAt(652),
    land: stepAt(710),
    deploy: stepAt(758),
    live: stepAt(806, 100),
  };
  const watch: Box = { x: 95, y: 842, w: 170, h: 56 };
  const clean: Box = { x: 122, y: 918, w: 116, h: 26 };
  const WATCH_C: Pt = [COL, watch.y + watch.h / 2];
  const CLEAN_C: Pt = [COL, clean.y + clean.h / 2];
  const checkEdge: Pt = [COL, steps.check.y];
  const mainTail: Pt[] = [checkEdge, CLEAN_C];
  const q0: Pt = [300, QUEUE_Y];
  const signalTarget = (bar: number): Pt => (bar < 0 ? [310, QUEUE_Y] : [BUS, BAR_Y[bar]]);
  const signalFrom = (src: number): Pt => [322, SOURCE_Y[src]];
  const signalPts = (src: number, bar: number): Pt[] => {
    const t = signalTarget(bar);
    return bar < 0 ? [signalFrom(src), [BUS, SOURCE_Y[src]], [BUS, QUEUE_Y], t] : [signalFrom(src), [BUS, SOURCE_Y[src]], t];
  };
  const lineToCheck = (k: number): Pt[] => [q0, [300, 391], [196, 391], [196, SLOT_Y[k]], [SLOT_X0 + 8, SLOT_Y[k]], [346, SLOT_Y[k]], [346, MERGE_Y], [COL, MERGE_Y], checkEdge];
  const sessionAt: Pt = [90, 422];
  const sessionToCheck: Pt[] = [sessionAt, [90, MERGE_Y], [COL, MERGE_Y], checkEdge];
  const at = (n: NodeId | "watch" | "clean"): Pt => (n === "watch" ? WATCH_C : n === "clean" ? CLEAN_C : [COL, centre(steps[n])[1]]);
  const left = (n: NodeId): Pt => [steps[n].x, centre(steps[n])[1]];
  const used: [number, number][] = [[0, 0], [0, 1], [0, 2], [0, -1], [1, 1], [1, 2], [1, 0], [2, 0], [2, 2], [2, 1]];
  return {
    W,
    H,
    stages: [
      { n: 1, name: "Signals", x0: 10, x1: 350, y: 14 },
      { n: 2, name: "Triage", x0: 10, x1: 350, y: 238 },
      { n: 3, name: "Build", x0: 10, x1: 350, y: 374 },
    ],
    signalsToday: { num: { x: 10, y: 52 }, size: 22, label: { x: 84, y: 52 } },
    sources: SOURCE_Y.map((y) => ({
      box: { x: 10, y: y - 13, w: 312, h: 26 },
      name: { x: 20, y: y + 4 },
      spark: [180, y + 6] as Pt,
      status: { x: 312, y: y + 4, anchor: "end" as const },
      port: [322, y] as Pt,
    })),
    triage: {
      box: { x: 10, y: 252, w: 340, h: 102 },
      title: null,
      rows: BAR_Y.map((y) => ({ box: { x: 22, y: y - 8, w: 310, h: 16 }, kind: { x: 32, y: y + 4 }, count: { x: 324, y: y + 4, anchor: "end" as const } })),
      chips: [0, 1, 2, 3, 4].map((i) => [236 + i * 11, QUEUE_Y] as Pt),
      queued: { x: 22, y: QUEUE_Y + 4 },
      queueHit: { x: 226, y: QUEUE_Y - 8, w: 92, h: 16 },
    },
    line: {
      box: { x: 190, y: 396, w: 160, h: 102 },
      title: { x: 202, y: 415 },
      count: { x: 338, y: 415, anchor: "end" },
      slots: SLOT_Y.map((y) => ({ x: SLOT_X0, y: y - 7.5, w: SLOT_X1 - SLOT_X0, h: 15 })),
      glyph: null,
    },
    session: { box: { x: 10, y: 396, w: 160, h: 56 }, glyph: [23, 413], title: { x: 34, y: 417 }, sub: { x: 22, y: 440 } },
    steps,
    watch: { box: watch, title: { x: watch.x + 12, y: watch.y + 22 }, days: { x: watch.x + 12, y: watch.y + 42 }, count: { x: watch.x + watch.w - 12, y: watch.y + 33, anchor: "end" } },
    clean,
    labels: {
      onPerson: { x: steps.decide.x + steps.decide.w + 10, y: centre(steps.decide)[1] + 4 },
      liveToday: { x: steps.live.x + steps.live.w + 10, y: centre(steps.live)[1] + 4 },
      sameChecks: null,
      back: { x: 350, y: 994, anchor: "end" },
      fix: { x: 36, y: centre(steps.check)[1] - 6, chip: false },
      revise: { x: 24, y: centre(steps.decide)[1] - 6, chip: false },
    },
    legend: { cols: [10, 186], rows: [1012, 1034, 1056] },
    edges: {
      signals: used.filter(([s]) => s < 3).map(([s, b]) => route(signalPts(s, b)).d),
      silent: [route(signalPts(3, 1)).d, route(signalPts(4, 2)).d],
      line: SLOT_Y.map((_, k) => route(lineToCheck(k)).d),
      person: route(sessionToCheck).d,
      main: route(mainTail).d,
    },
    signalRoute: memo((src: number, bar: number) => route(signalPts(src, bar))),
    signalFrom,
    signalTarget,
    lineRoute: memo((k: number) => route([...lineToCheck(k), ...mainTail.slice(1)])),
    q0,
    slotIn: (k) => [SLOT_X0 + 8, SLOT_Y[k]],
    slotOut: (k) => [SLOT_X1 - 8, SLOT_Y[k]],
    personRoute: route([...sessionToCheck, ...mainTail.slice(1)]),
    sessionAt,
    checkEdge,
    at,
    fixRoute: route([at("check"), left("check"), [30, centre(steps.check)[1]], [30, 452]]),
    reviseRoute: route([at("decide"), left("decide"), [18, centre(steps.decide)[1]], [18, 452]]),
    regressRoute: route([WATCH_C, [300, WATCH_C[1]], [300, 976], [366, 976], [366, BAR_Y[1]], [BUS, BAR_Y[1]]]),
  };
}

// ---------- schedule ----------
export type Kind = "signal" | "line" | "person" | "back" | "regress";
export type Zone = { a: number; b: number; z: string };
export type Piece = {
  id: string;
  kind: Kind;
  route: Route;
  /** Loop phase (0..L) at which the piece starts. */
  begin: number;
  /** Local time (s) → fraction along the route. */
  keys: { t: number; f: number }[];
  end: number;
  zones: Zone[];
  events: { t: number; e: string }[];
  fadeIn: number;
  fadeOut: number;
  /** A line piece's machine slot: it fills from a to b as the run works, and is held until c, when the run reaches Decide. */
  slot?: { k: number; a: number; b: number; c: number };
};

class Run {
  pieces: Piece[] = [];
  private cur!: Piece;
  private t: number;
  private f = 0;
  constructor(private id: string, start: number) {
    this.t = start;
  }
  on(kind: Kind, r: Route, from: Pt, fade: [number, number] = [0.15, 0.15]) {
    this.f = fracOf(r, from);
    this.cur = { id: `${this.id}-${this.pieces.length}`, kind, route: r, begin: this.t, keys: [{ t: 0, f: this.f }], end: 0, zones: [], events: [], fadeIn: fade[0], fadeOut: fade[1] };
    this.pieces.push(this.cur);
    return this;
  }
  local() {
    return this.t - this.cur.begin;
  }
  private zone(a: number, zone?: string) {
    if (zone) for (const z of zone.split(" ")) this.cur.zones.push({ a, b: this.local(), z });
  }
  /** Move to `p` over `dur` seconds (or at `speed` px/s when dur < 0). */
  to(p: Pt, dur: number, zone?: string) {
    const f = fracOf(this.cur.route, p);
    const d = dur >= 0 ? dur : (Math.abs(f - this.f) * this.cur.route.len) / -dur;
    const a = this.local();
    this.t += d;
    this.f = f;
    this.cur.keys.push({ t: this.local(), f });
    this.zone(a, zone);
    this.cur.end = this.local();
    return this;
  }
  hold(dur: number, zone?: string) {
    const a = this.local();
    this.t += dur;
    this.cur.keys.push({ t: this.local(), f: this.f });
    this.zone(a, zone);
    this.cur.end = this.local();
    return this;
  }
  /** A highlight that outlasts the token (a problem flashing as a signal joins it). */
  flash(z: string, dur = 0.7) {
    this.cur.zones.push({ a: this.local(), b: this.local() + dur, z });
    return this;
  }
  event(e: string) {
    this.cur.events.push({ t: this.local(), e });
    return this;
  }
  /** Take slot k and work across it. The slot stays held until `release`. */
  work(g: Plan, k: number, dur: number) {
    const a = this.local();
    this.to(g.slotOut(k), dur);
    this.cur.slot = { k, a, b: this.local(), c: this.local() };
    return this;
  }
  /** The run reaches Decide and waits on a person: it gives its slot back. */
  release() {
    const s = this.cur.slot;
    if (s) {
      s.c = this.local();
      this.cur.zones.push({ a: s.a, b: s.c, z: `slot:${s.k}` });
    }
    return this;
  }
}

type Who = "line" | "person";

/** From wherever the token is to Decide's door: Check, Review, then into Decide. */
function toDecide(g: Plan, run: Run, who: Who, failCheck = false) {
  run.to(g.checkEdge, -150).to(g.at("check"), 0.25, failCheck ? "n:check:fail" : `n:check:${who}`);
  if (failCheck) return run.hold(0.6, "n:check:fail");
  return run.hold(0.5, `n:check:${who}`).to(g.at("review"), 0.6).hold(0.8, `n:review:${who}`).to(g.at("decide"), 0.6);
}

/** Decide's Ship answer onward: Land, Deploy, Live, the watch, then Closed clean (or a regression). */
function ship(g: Plan, run: Run, who: Who, regress = false) {
  run.to(g.at("land"), 0.7).hold(0.5, `n:land:${who}`)
    .to(g.at("deploy"), 0.6).hold(1.2, `n:deploy:${who}`)
    .to(g.at("live"), 0.55).event("live").hold(0.3, `n:live:${who}`)
    .to(g.at("watch"), 0.6).hold(regress ? 3.5 : 6, "watch");
  if (regress) {
    run.on("regress", g.regressRoute, g.at("watch"), [0.12, 0.3]).to(g.signalTarget(1), -260, "regress").event("signal").event("bar:1").flash("bar:1");
  } else {
    run.to(g.at("clean"), 0.5).event("clean").flash("clean", 0.9);
  }
}

function lineRun(g: Plan, id: string, start: number, k: number, regress = false) {
  const run = new Run(id, start);
  run.on("line", g.lineRoute(k), g.q0, [0.3, 0.15]).hold(0.3).to(g.slotIn(k), 1.0).work(g, k, 6);
  toDecide(g, run, "line").release().hold(3.0, "decide n:decide:line");
  ship(g, run, "line", regress);
  return run.pieces;
}

function personRun(g: Plan, id: string, start: number, way: "plain" | "fix" | "revise") {
  const run = new Run(id, start);
  const again = () => run.on("person", g.personRoute, g.sessionAt, [0.05, 0.15]).hold(1.6, "n:session");
  run.on("person", g.personRoute, g.sessionAt, [0.05, 0.15]).hold(way === "plain" ? 2.5 : 2, "n:session");
  if (way === "fix") {
    toDecide(g, run, "person", true);
    run.on("back", g.fixRoute, g.at("check")).to(g.sessionAt, -110, "back");
    again();
  } else if (way === "revise") {
    toDecide(g, run, "person").hold(2.5, "decide n:decide:person");
    run.on("back", g.reviseRoute, g.at("decide")).to(g.sessionAt, -130, "back");
    again();
  }
  toDecide(g, run, "person").hold(way === "revise" ? 2 : 3, "decide n:decide:person");
  ship(g, run, "person");
  return run.pieces;
}

/** Signals: the flowing sources' dots, a couple of them opening new problems (the queue). */
function signalPieces(g: Plan): Piece[] {
  const out: Piece[] = [];
  const plan: { src: number; n: number; offset: number; bars: number[] }[] = [
    { src: 0, n: 13, offset: 0.2, bars: [0, 1, 2, -1, 1, 0, 2, 1, 0, -1, 2, 1, 0] },
    { src: 1, n: 5, offset: 1.1, bars: [1, 2, 1, 2, 0] },
    { src: 2, n: 3, offset: 5.3, bars: [0, 2, 1] },
  ];
  for (const { src, n, offset, bars } of plan) {
    for (let i = 0; i < n; i++) {
      const bar = bars[i % bars.length];
      const run = new Run(`s${src}-${i}`, offset + (i * L) / n);
      run.on("signal", g.signalRoute(src, bar), g.signalFrom(src), [0.2, 0.25])
        .to(g.signalTarget(bar), -120)
        .event("signal")
        .event(`src:${src}`)
        .event(`bar:${bar}`)
        .flash(bar < 0 ? "queue" : `bar:${bar}`);
      out.push(...run.pieces);
    }
  }
  return out;
}

const norm = (t: number) => ((t % L) + L) % L;

/** A layout with its schedule laid on it. */
export type Floor = { plan: Plan; pieces: Piece[]; changes: number[] };

function buildFloor(plan: Plan): Floor {
  const g = plan;
  const pieces = [
    ...signalPieces(g),
    // Line runs; slots are assigned so no two runs ever hold one slot at once.
    ...lineRun(g, "l0", 0, 2, true),
    ...lineRun(g, "l5", 3.2, 1),
    ...lineRun(g, "l1", 6.4, 0),
    ...lineRun(g, "l2", 12.8, 2),
    ...lineRun(g, "l6", 16, 1),
    ...lineRun(g, "l3", 19.2, 0),
    ...lineRun(g, "l4", 25.6, 3),
    ...personRun(g, "p0", 8.75, "plain"),
    ...personRun(g, "p1", 19.6, "fix"),
    ...personRun(g, "p2", 1.5, "revise"),
  ].map((p) => ({ ...p, begin: norm(p.begin) }));
  const s = new Set<number>();
  for (const p of pieces) {
    for (const z of p.zones) {
      s.add(Math.round(norm(p.begin + z.a) * 1000) / 1000);
      s.add(Math.round(norm(p.begin + z.b) * 1000) / 1000);
    }
    for (const ev of p.events) s.add(Math.round(norm(p.begin + ev.t) * 1000) / 1000);
  }
  return { plan, pieces, changes: [...s].sort((a, b) => a - b) };
}

export const WIDE = buildFloor(widePlan());
export const TALL = buildFloor(tallPlan());

// ---------- reading the schedule ----------
const localAt = (p: Piece, t: number) => norm(t - p.begin);
const fmt4 = (xs: number[]) => xs.map((x) => Math.min(1, Math.max(0, x)).toFixed(4)).join(";");

/** SMIL attributes for a piece: motion keys and opacity keys over one loop. */
export function smil(p: Piece) {
  const kt = p.keys.map((k) => k.t / L);
  const kp = p.keys.map((k) => k.f);
  if (kt[kt.length - 1] < 1) {
    kt.push(1);
    kp.push(kp[kp.length - 1]);
  }
  const e = p.end / L;
  const ot = [0, p.fadeIn / L, Math.max(p.fadeIn, p.end - p.fadeOut) / L, e, 1];
  return { keyTimes: fmt4(kt), keyPoints: fmt4(kp), opacityTimes: fmt4(ot), opacityValues: e >= 1 ? "0;1;1;1;1" : "0;1;1;0;0" };
}

/** Where a piece is at loop time `t`, for the still frame. */
export function snapshot(p: Piece, t: number): { x: number; y: number; o: number } {
  const lt = localAt(p, t);
  if (lt > p.end) return { x: 0, y: 0, o: 0 };
  let f = p.keys[p.keys.length - 1].f;
  for (let i = 1; i < p.keys.length; i++) {
    const a = p.keys[i - 1];
    const b = p.keys[i];
    if (lt <= b.t) {
      f = b.t === a.t ? b.f : a.f + ((b.f - a.f) * (lt - a.t)) / (b.t - a.t);
      break;
    }
  }
  const [x, y] = pointAt(p.route, f);
  const o = Math.min(1, lt / Math.max(p.fadeIn, 1e-3), (p.end - lt) / Math.max(p.fadeOut, 1e-3));
  return { x, y, o: Math.max(0, o) };
}

/** Every zone active at loop time `t`, with how many pieces hold it. */
export function zonesAt(f: Floor, t: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of f.pieces) {
    const lt = localAt(p, t);
    for (const z of p.zones) if (lt >= z.a && lt < z.b) m.set(z.z, (m.get(z.z) ?? 0) + 1);
  }
  return m;
}

/** How many times event `e` fired in (t0, t1], loop times unwrapped. */
export function countEvents(f: Floor, e: string, t0: number, t1: number): number {
  let n = 0;
  for (const p of f.pieces)
    for (const ev of p.events) {
      if (ev.e !== e) continue;
      const g = p.begin + ev.t;
      n += Math.floor((t1 - g) / L) - Math.floor((t0 - g) / L);
    }
  return n;
}

/** Seconds from `t` to the next moment a counter or highlight changes. */
export function untilNextChange(f: Floor, t: number): number {
  const ph = norm(t);
  const next = f.changes.find((c) => c > ph + 0.005);
  return next === undefined ? L - ph + (f.changes[0] ?? 0) : next - ph;
}

// ---------- machine slots ----------
const FILL_MIN = 6;
const FILL_FADE = 0.6;

/** SMIL attributes for the slot row a line piece fills, or null when it works in none. */
export function slotFill(p: Piece, slot: Box) {
  if (!p.slot) return null;
  const { k, a, b, c } = p.slot;
  const f = (x: number) => Math.min(1, Math.max(0, x / L)).toFixed(4);
  return {
    k,
    widthTimes: [0, a, b, L].map(f).join(";"),
    widthValues: `${FILL_MIN};${FILL_MIN};${slot.w - 2};${slot.w - 2}`,
    opacityTimes: [0, a, a + 0.15, c, c + FILL_FADE, L].map(f).join(";"),
    opacityValues: "0;0;1;1;0;0",
  };
}

/** The slot fill at loop time `t`, for the still frame. */
export function slotSnapshot(p: Piece, slot: Box, t: number): { k: number; w: number; o: number } | null {
  if (!p.slot) return null;
  const { k, a, b, c } = p.slot;
  const lt = localAt(p, t);
  if (lt < a || lt > c + FILL_FADE) return null;
  const full = slot.w - 2;
  const w = lt < b ? FILL_MIN + ((full - FILL_MIN) * (lt - a)) / (b - a) : full;
  const o = lt > c ? 1 - (lt - c) / FILL_FADE : 1;
  return { k, w, o };
}
