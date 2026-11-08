// The Change run on /features/flows: its steps, ways out and ways back, the
// beats built from the reader's answers at Decide, and the geometry both
// drawings share (ChangeRun.tsx draws it, ChangeRunMoment.tsx narrates it).
import { createElement, type ReactNode } from "react";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { BACK, BAD, GOOD, LINE, PERSON, TEXT } from "./base";
import { CHANGE } from "./story";

// A .ts module has no JSX, and KeyCap types children as a required prop.
// eslint-disable-next-line react/no-children-prop
const keyMeta = (k: string) => createElement(KeyCap, { size: "xs", children: k });

// ---------- Steps, ways out, ways back ----------

export type StepId = "session" | "check" | "review" | "decide" | "land" | "deploy" | "live";
export type Kind = "session" | "shell" | "agent" | "person" | "end";
export const STEPS: Record<StepId, { label: string; kind: Kind }> = {
  session: { label: "Session", kind: "session" },
  check: { label: "Check", kind: "shell" },
  review: { label: "Review", kind: "agent" },
  decide: { label: "Decide", kind: "person" },
  land: { label: "Land", kind: "shell" },
  deploy: { label: "Deploy", kind: "shell" },
  live: { label: "Live", kind: "end" },
};
export const ORDER: StepId[] = ["session", "check", "review", "decide", "land", "deploy", "live"];

export type ChipTone = "back" | "end" | "on";
export type Chip = { id: string; step: StepId; label: string; tone: ChipTone; row: number };
export const CHIPS: Chip[] = [
  { id: "check-failed", step: "check", label: "Checks failed", tone: "back", row: 0 },
  { id: "changes-asked", step: "review", label: "Changes asked", tone: "back", row: 0 },
  { id: "rejected", step: "review", label: "Rejected", tone: "end", row: 1 },
  { id: "revise", step: "decide", label: "Revise", tone: "back", row: 0 },
  { id: "dropped", step: "decide", label: "Dropped", tone: "end", row: 1 },
  { id: "already", step: "land", label: "Already landed", tone: "on", row: 0 },
  { id: "conflict", step: "land", label: "Conflict", tone: "back", row: 1 },
  { id: "not-shipped", step: "land", label: "Not shipped", tone: "end", row: 2 },
  { id: "deploy-failed", step: "deploy", label: "Deploy failed", tone: "end", row: 0 },
];
export const chipLabel = (c: Chip) => (c.tone === "back" ? `↺ ${c.label}` : c.label);
export const CHIP_FONT = 15;
export const chipW = (c: Chip) => chipLabel(c).length * 9 + 18;

type WayKey = "fix" | "address" | "revise" | "resolve";
export const WAYS: { key: WayKey; label: string; step: StepId; chip: string }[] = [
  { key: "fix", label: "Fix check", step: "check", chip: "check-failed" },
  { key: "address", label: "Address review", step: "review", chip: "changes-asked" },
  { key: "revise", label: "Revise", step: "decide", chip: "revise" },
  { key: "resolve", label: "Resolve conflict", step: "land", chip: "conflict" },
];
const wayOfChip = (id: string) => WAYS.find((w) => w.chip === id);

/** What each step can do next, for the step a reader clicks. */
export const WAYS_OUT: Record<StepId, { out: string; to: string; tone: ChipTone | "go" | "ok" }[]> = {
  session: [{ out: "frozen into a commit", to: "Check", tone: "go" }],
  check: [
    { out: "Passed", to: "Review", tone: "ok" },
    { out: "Checks failed", to: "Fix check, then Check", tone: "back" },
  ],
  review: [
    { out: "Approved", to: "Decide", tone: "ok" },
    { out: "Changes asked", to: "Address review, then Check", tone: "back" },
    { out: "Rejected", to: "ends with the reviewer's note", tone: "end" },
  ],
  decide: [
    { out: "Ship", to: "Land", tone: "go" },
    { out: "Revise", to: "your note to the session, then Check", tone: "back" },
    { out: "Dropped", to: "ends unshipped", tone: "end" },
  ],
  land: [
    { out: "Rebase, Land", to: "Deploy", tone: "go" },
    { out: "Already landed", to: "Deploy", tone: "on" },
    { out: "default branch moved", to: "Rebase again", tone: "on" },
    { out: "Conflict", to: "Resolve conflict, then Check", tone: "back" },
    { out: "Not shipped", to: "ends", tone: "end" },
  ],
  deploy: [
    { out: "live", to: "Live", tone: "go" },
    { out: "Deploy failed", to: "ends", tone: "end" },
  ],
  live: [{ out: "every touched target live", to: "the run ends", tone: "go" }],
};

// ---------- The run, built from the reader's answers at Decide ----------

export type Tone = "line" | "good" | "back" | "person" | "bad" | "plain";
export const TONE: Record<Tone, string> = { line: LINE, good: GOOD, back: BACK, person: PERSON, bad: BAD, plain: TEXT };

export type Answer = "S" | "R" | "D";
type MomentKind =
  | "freeze" | "checkFail" | "fix" | "checkPass" | "reviewAsk" | "address" | "reviewOk"
  | "decide" | "pressed" | "revise" | "rebase" | "land" | "deploy" | "live" | "dropped" | "cap";

export type Beat = {
  step: StepId;
  ch: number;
  dwell: number;
  tag: string;
  tone: Tone;
  kind: MomentKind;
  log: { name: string; out: string; meta?: ReactNode };
  via?: WayKey;
  chip?: string;
  /** The token leaves for this chip and the run ends there. */
  end?: string;
  terminal?: boolean;
  /** Decide waiting on an answer the reader has not given yet. */
  pending?: boolean;
  key?: Answer;
  sub?: "rebase" | "land";
  /** The snapshot this beat checked or produced. */
  sha?: string;
  visit?: number;
};

export const CHAPTERS = ["Freeze", "Check", "Review", "Decide", "Land", "Deploy"];
const REVISED = ["5b8d2c6", "9e1f4a3", "2c7a9d0"];
export const AUTO_SHIP_MS = 4000;
export const MOVE_MS = 760; // a step forward
export const LOOP_MS = 1500; // a way back, whatever its drawn length

const PREFIX: Beat[] = [
  { step: "session", ch: 0, dwell: 2600, sha: CHANGE.frozen, kind: "freeze", tag: "frozen", tone: "person", log: { name: "Session", out: "frozen into a commit", meta: CHANGE.frozen } },
  { step: "check", ch: 1, dwell: 2600, chip: "check-failed", kind: "checkFail", tag: "Checks failed", tone: "back", log: { name: "Check", out: "Checks failed", meta: CHANGE.frozen } },
  { step: "session", ch: 1, dwell: 2300, via: "fix", visit: 1, kind: "fix", tag: "Fix check 1/3", tone: "back", log: { name: "Fix check", out: "visit 1 of 3" } },
  { step: "check", ch: 1, dwell: 1800, sha: CHANGE.afterFix, kind: "checkPass", tag: "Passed", tone: "good", log: { name: "Check", out: "Passed", meta: CHANGE.afterFix } },
  { step: "review", ch: 2, dwell: 2900, chip: "changes-asked", kind: "reviewAsk", tag: "Changes asked", tone: "back", log: { name: "Review", out: "Changes asked", meta: CHANGE.afterFix } },
  { step: "session", ch: 2, dwell: 2200, via: "address", visit: 1, kind: "address", tag: "Address review 1/3", tone: "back", log: { name: "Address review", out: "visit 1 of 3" } },
  { step: "check", ch: 2, dwell: 1500, sha: CHANGE.approved, kind: "checkPass", tag: "Passed", tone: "good", log: { name: "Check", out: "Passed", meta: CHANGE.approved } },
  { step: "review", ch: 2, dwell: 2000, kind: "reviewOk", tag: "Approved", tone: "good", log: { name: "Review", out: "Approved", meta: CHANGE.approved } },
];

export function buildBeats(answers: Answer[]): Beat[] {
  const beats = [...PREFIX];
  let revises = 0;
  let snap: string = CHANGE.approved;
  for (let i = 0; ; i++) {
    const a = answers[i];
    beats.push({ step: "decide", ch: 3, dwell: a ? 1700 : AUTO_SHIP_MS, kind: "decide", pending: !a, tag: "waiting on you", tone: "person", log: { name: "Decide", out: "waiting on a person", meta: snap } });
    if (!a) break;
    if (a === "S") {
      beats.push(
        { step: "decide", ch: 3, dwell: 1300, key: "S", kind: "pressed", tag: "Ship", tone: "person", log: { name: "Decide", out: "Ship", meta: keyMeta("S") } },
        { step: "land", ch: 4, dwell: 1600, sub: "rebase", kind: "rebase", tag: "Rebase", tone: "plain", log: { name: "Rebase", out: "onto main", meta: CHANGE.approved } },
        { step: "land", ch: 4, dwell: 1700, sub: "land", kind: "land", sha: CHANGE.landed, tag: "on main", tone: "plain", log: { name: "Land", out: "on main", meta: CHANGE.landed } },
        { step: "deploy", ch: 5, dwell: 3400, kind: "deploy", tag: "parked", tone: "line", log: { name: "Deploy", out: "Wait for live, parked", meta: "2 targets" } },
        { step: "live", ch: 5, dwell: 0, kind: "live", terminal: true, tag: "web, backend", tone: "line", log: { name: "Live", out: "web, backend", meta: `${CHANGE.deploys.web}, ${CHANGE.deploys.backend}` } },
      );
      break;
    }
    if (a === "D") {
      beats.push({ step: "decide", ch: 3, dwell: 0, key: "D", end: "dropped", chip: "dropped", terminal: true, kind: "dropped", tag: "Dropped", tone: "bad", log: { name: "Decide", out: "Dropped", meta: keyMeta("D") } });
      break;
    }
    if (revises === 3) {
      beats.push({ step: "decide", ch: 3, dwell: 0, key: "R", terminal: true, kind: "cap", tag: "run ends", tone: "bad", log: { name: "Revise", out: "a fourth visit ends the run" } });
      break;
    }
    revises++;
    snap = REVISED[revises - 1];
    beats.push(
      { step: "decide", ch: 3, dwell: 1100, key: "R", chip: "revise", kind: "pressed", tag: "Revise", tone: "person", log: { name: "Decide", out: "Revise", meta: keyMeta("R") } },
      { step: "session", ch: 3, dwell: 2000, via: "revise", visit: revises, kind: "revise", tag: `Revise ${revises}/3`, tone: "back", log: { name: "Revise", out: `visit ${revises} of 3` } },
      { step: "check", ch: 3, dwell: 1300, sha: snap, kind: "checkPass", tag: "Passed", tone: "good", log: { name: "Check", out: "Passed", meta: snap } },
      { step: "review", ch: 3, dwell: 1500, kind: "reviewOk", tag: "Approved", tone: "good", log: { name: "Review", out: "Approved", meta: snap } },
    );
  }
  return beats;
}

export const SHIP_RUN = buildBeats(["S"]);

/** What lit up to beat `i`. */
export function stateAt(beats: Beat[], i: number) {
  const upto = beats.slice(0, i + 1);
  const lit = new Set(upto.map((b) => b.chip).filter(Boolean) as string[]);
  const visits: Record<WayKey, number> = { fix: 0, address: 0, revise: 0, resolve: 0 };
  const loops = new Set<WayKey>();
  const edges = new Set<string>();
  upto.forEach((b, k) => {
    if (b.via) { visits[b.via]++; loops.add(b.via); }
    const prev = upto[k - 1];
    if (prev && !b.via && !b.end && prev.step !== b.step) edges.add(`${prev.step}>${b.step}`);
  });
  return { lit, visits, loops, edges };
}

// ---------- Geometry: one model, two drawings ----------

export type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
export const dist = (a: Pt, b: Pt) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
export const polyLen = (pts: Pt[]) => pts.slice(1).reduce((n, p, k) => n + dist(pts[k], p), 0);

export type Geo = {
  vertical: boolean;
  W: number;
  H: number;
  node: Record<StepId, Rect>;
  dock: (s: StepId) => Pt;
  /** The token's way back from step `s` to the Session, and where along it the drawn loop starts. */
  loop: (s: StepId) => { pts: Pt[]; d: string; start: Pt };
  endPts: (from: StepId, chip: Chip) => Pt[];
  edge: (a: StepId, b: StepId) => string;
  chipAt: (c: Chip) => { x: number; y: number };
  rail: string;
  drop: (s: StepId) => string;
  wayLabel: (w: (typeof WAYS)[number]) => { x: number; y: number; anchor: "middle" | "start"; pill: boolean };
  tag?: (s: StepId) => Pt & { anchor: "start" | "middle" };
  already?: string;
  branchArc?: string;
  landCells: (r: Rect) => { rebase: Rect; land: Rect; arrow: Pt; title: Pt };
};

export const CHIP_H = 24;

/** Wide screens: the row the app draws, ways out hanging under each step, the rail along the bottom. */
function horizontal(): Geo {
  const NY = 46, NH = 48, CY = NY + NH / 2, NB = NY + NH, RAIL = 226, CHIP_Y = 106, PITCH = 30, RX = 30;
  const xs: Record<StepId, [number, number]> = { session: [16, 110], check: [166, 124], review: [330, 136], decide: [506, 136], land: [682, 222], deploy: [940, 124], live: [1104, 84] };
  const node = Object.fromEntries(ORDER.map((s) => [s, { x: xs[s][0], y: NY, w: xs[s][1], h: NH }])) as Record<StepId, Rect>;
  const SX = node.session.x + node.session.w / 2;
  const vx = (s: StepId) => node[s].x + 22;
  const dock = (s: StepId): Pt => (s === "session" ? { x: SX, y: CY } : { x: node[s].x - 14, y: CY });
  const chipAt = (c: Chip) => ({ x: node[c.step].x, y: CHIP_Y + c.row * PITCH });
  const deployX = node.deploy.x;
  const alreadyChip = CHIPS.find((c) => c.id === "already")!;
  const lc = node.land;
  return {
    vertical: false, W: 1200, H: 254, node, dock, chipAt,
    loop: (s) => ({
      pts: [dock(s), { x: vx(s), y: CY }, { x: vx(s), y: RAIL }, { x: RX, y: RAIL }, { x: RX, y: CY }, { x: SX, y: CY }],
      d: `M${vx(s)} ${NB} V${RAIL} H${RX} V${NB + 2}`,
      start: { x: vx(s), y: NB },
    }),
    endPts: (from, c) => [dock(from), { x: dock(from).x, y: chipAt(c).y + CHIP_H / 2 }],
    edge: (a, b) => `M${node[a].x + node[a].w + 3} ${CY} H${node[b].x - 3}`,
    rail: `M${vx("land")} ${RAIL} H${RX} V${NB + 2}`,
    drop: (s) => `M${vx(s)} ${NB} V${RAIL}`,
    wayLabel: (w) => ({ x: vx(w.step), y: RAIL, anchor: "middle", pill: true }),
    tag: (s) => (s === "session" ? { x: node.session.x, y: NY - 16, anchor: "start" } : { x: node[s].x + node[s].w / 2, y: NY - 16, anchor: "middle" }),
    already: `M${lc.x + chipW(alreadyChip)} ${CHIP_Y + CHIP_H / 2} H${deployX - 22} Q${deployX - 16} ${CHIP_Y + CHIP_H / 2} ${deployX - 16} ${CHIP_Y + 6} V${CY + 6}`,
    branchArc: `M${lc.x + 191} ${NY - 1} C${lc.x + 187} ${NY - 13} ${lc.x + 122} ${NY - 13} ${lc.x + 118} ${NY - 2}`,
    landCells: (r) => ({
      title: { x: r.x + 36, y: r.y + r.h / 2 + 5 },
      rebase: { x: r.x + 84, y: r.y + r.h / 2 - 12, w: 68, h: 24 },
      arrow: { x: r.x + 159, y: r.y + r.h / 2 },
      land: { x: r.x + 166, y: r.y + r.h / 2 - 12, w: 50, h: 24 },
    }),
  };
}

/** Narrow screens: steps stacked, ways out beside each, the rail up the left edge into the Session. */
function vertical(): Geo {
  const W = 340, RX = 12, NX = 30, NW = 136, CHX = 176, GAP = 34, PITCH = 30, SUB = 20;
  const CX = NX + NW / 2;
  const node = {} as Record<StepId, Rect>;
  const chipY: Record<string, number> = {};
  let y = 18;
  for (const s of ORDER) {
    const h = s === "land" ? 68 : 44;
    let cy = y;
    for (const c of CHIPS.filter((x) => x.step === s).sort((a, b) => a.row - b.row)) {
      chipY[c.id] = cy;
      cy += PITCH + (c.tone === "back" ? SUB : 0);
    }
    node[s] = { x: NX, y, w: NW, h };
    y += Math.max(h, cy - y - 6) + GAP;
  }
  const mid = (s: StepId) => node[s].y + node[s].h / 2;
  const dock = (s: StepId): Pt => (s === "session" ? { x: CX, y: mid("session") } : { x: CX, y: node[s].y - 13 });
  const chipAt = (c: Chip) => ({ x: CHX, y: chipY[c.id] });
  const rowY = (s: StepId) => (s === "land" ? node.land.y + 22 : mid(s));
  return {
    vertical: true, W, H: y - GAP + 18, node, dock, chipAt,
    loop: (s) => ({
      pts: [dock(s), { x: CX, y: rowY(s) }, { x: RX, y: rowY(s) }, { x: RX, y: mid("session") }, { x: CX, y: mid("session") }],
      d: `M${NX} ${rowY(s)} H${RX} V${mid("session")} H${NX - 2}`,
      start: { x: NX, y: rowY(s) },
    }),
    endPts: (from, c) => [dock(from), { x: CX, y: chipAt(c).y + CHIP_H / 2 }, { x: CHX - 12, y: chipAt(c).y + CHIP_H / 2 }],
    edge: (a, b) => `M${CX} ${node[a].y + node[a].h + 3} V${node[b].y - 3}`,
    rail: `M${NX} ${rowY("land")} H${RX} V${mid("session")} H${NX - 2}`,
    drop: (s) => `M${NX} ${rowY(s)} H${RX}`,
    wayLabel: (w) => {
      const c = CHIPS.find((x) => x.id === w.chip)!;
      return { x: CHX + 4, y: chipY[c.id] + CHIP_H + 14, anchor: "start", pill: false };
    },
    landCells: (r) => ({
      title: { x: r.x + 36, y: r.y + 22 + 5 },
      rebase: { x: r.x + 7, y: r.y + 37, w: 68, h: 24 },
      arrow: { x: r.x + 81, y: r.y + 49 },
      land: { x: r.x + 85, y: r.y + 37, w: 48, h: 24 },
    }),
  };
}

export const GEO_H = horizontal();
export const GEO_V = vertical();

/** The token's waypoints into beat `i`, and how long each leg takes (fixed per move, so both drawings keep one clock). */
export function legs(geo: Geo, beats: Beat[], i: number): { pts: Pt[]; ms: number[]; ease: string } {
  const b = beats[i];
  const prev = beats[i - 1];
  if (!prev) return { pts: [geo.dock(b.step)], ms: [], ease: "linear" };
  let pts: Pt[];
  let total = LOOP_MS;
  if (b.via) pts = geo.loop(prev.step).pts;
  else if (b.end) { pts = geo.endPts(prev.step, CHIPS.find((c) => c.id === b.end)!); total = 700; }
  else if (prev.step === b.step) return { pts: [geo.dock(b.step)], ms: [], ease: "linear" };
  else return { pts: [geo.dock(prev.step), geo.dock(b.step)], ms: [MOVE_MS], ease: "cubic-bezier(.55,0,.25,1)" };
  const len = polyLen(pts);
  return { pts, ms: pts.slice(1).map((p, k) => (dist(pts[k], p) / len) * total), ease: "linear" };
}
export function travelMs(beats: Beat[], i: number) {
  const b = beats[i];
  const prev = beats[i - 1];
  if (!prev) return 0;
  if (b.via) return LOOP_MS;
  if (b.end) return 700;
  return prev.step === b.step ? 0 : MOVE_MS;
}
