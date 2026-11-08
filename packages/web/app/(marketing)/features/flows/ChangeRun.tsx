"use client";

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { useEventListener } from "@/hooks/useEventListener";
import { useNearViewport } from "@/hooks/useNearViewport";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { SOL } from "../../blog/blogChrome";
import { BACK, BAD, DIM, FLOOR, GOOD, HAIR, INK, LINE, MUTED, PAPER, PERSON, Section, TEXT, tint, usePlayOnView, useStill } from "./kit";
import { CHANGE, PROBLEM } from "./story";
import "./changerun.css";

/*
 * One change through the Change flow (templates/change.cast), as a run the
 * reader can steer. The flow is drawn the way the app draws it; a token
 * travels it, slipping behind each box to pass through, and takes the violet
 * rail back to the Session on every way back, drawing the loop as it goes.
 *
 * The run is a list of beats built from the reader's answers at Decide
 * (`buildBeats`): Ship lands and deploys, Revise sends the change back to the
 * session (3 visits; a fourth ends the run), Drop ends it. Left alone at Decide
 * for 4 seconds, the run presses Ship itself. The same beats drive two
 * drawings: a horizontal flow on wide screens and a vertical one below 1280px,
 * with travel times fixed per move so both stay in step with one clock.
 *
 * Before it plays, in still mode and in the prerender, it shows the finished
 * Ship run: the path taken with both loops back, and the whole log.
 */

// ---------- Steps, ways out, ways back ----------

type StepId = "session" | "check" | "review" | "decide" | "land" | "deploy" | "live";
type Kind = "session" | "shell" | "agent" | "person" | "end";
const STEPS: Record<StepId, { label: string; kind: Kind }> = {
  session: { label: "Session", kind: "session" },
  check: { label: "Check", kind: "shell" },
  review: { label: "Review", kind: "agent" },
  decide: { label: "Decide", kind: "person" },
  land: { label: "Land", kind: "shell" },
  deploy: { label: "Deploy", kind: "shell" },
  live: { label: "Live", kind: "end" },
};
const ORDER: StepId[] = ["session", "check", "review", "decide", "land", "deploy", "live"];

type ChipTone = "back" | "end" | "on";
type Chip = { id: string; step: StepId; label: string; tone: ChipTone; row: number };
const CHIPS: Chip[] = [
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
const chipLabel = (c: Chip) => (c.tone === "back" ? `↺ ${c.label}` : c.label);
const CHIP_FONT = 13;
const chipW = (c: Chip) => chipLabel(c).length * 7.8 + 18;

type WayKey = "fix" | "address" | "revise" | "resolve";
const WAYS: { key: WayKey; label: string; step: StepId; chip: string }[] = [
  { key: "fix", label: "Fix check", step: "check", chip: "check-failed" },
  { key: "address", label: "Address review", step: "review", chip: "changes-asked" },
  { key: "revise", label: "Revise", step: "decide", chip: "revise" },
  { key: "resolve", label: "Resolve conflict", step: "land", chip: "conflict" },
];
const wayOfChip = (id: string) => WAYS.find((w) => w.chip === id);

/** What each step can do next, for the step a reader clicks. */
const WAYS_OUT: Record<StepId, { out: string; to: string; tone: ChipTone | "go" | "ok" }[]> = {
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

type Tone = "line" | "good" | "back" | "person" | "bad" | "plain";
const TONE: Record<Tone, string> = { line: LINE, good: GOOD, back: BACK, person: PERSON, bad: BAD, plain: TEXT };

type Answer = "S" | "R" | "D";
type MomentKind =
  | "freeze" | "checkFail" | "fix" | "checkPass" | "reviewAsk" | "address" | "reviewOk"
  | "decide" | "pressed" | "revise" | "rebase" | "land" | "deploy" | "live" | "dropped" | "cap";

type Beat = {
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

const CHAPTERS = ["Freeze", "Check", "Review", "Decide", "Land", "Deploy"];
const REVISED = ["5b8d2c6", "9e1f4a3", "2c7a9d0"];
const AUTO_SHIP_MS = 4000;
const MOVE_MS = 760; // a step forward
const LOOP_MS = 1500; // a way back, whatever its drawn length

const PREFIX: Beat[] = [
  { step: "session", ch: 0, dwell: 2600, sha: CHANGE.frozen, kind: "freeze", tag: "frozen", tone: "person", log: { name: "Session", out: "frozen into a commit", meta: CHANGE.frozen } },
  { step: "check", ch: 1, dwell: 2600, chip: "check-failed", kind: "checkFail", tag: "Checks failed", tone: "back", log: { name: "Check", out: "Checks failed", meta: "1 failed" } },
  { step: "session", ch: 1, dwell: 2300, via: "fix", visit: 1, kind: "fix", tag: "Fix check 1/3", tone: "back", log: { name: "Fix check", out: "visit 1 of 3" } },
  { step: "check", ch: 1, dwell: 1800, sha: CHANGE.afterFix, kind: "checkPass", tag: "Passed", tone: "good", log: { name: "Check", out: "Passed", meta: CHANGE.afterFix } },
  { step: "review", ch: 2, dwell: 2900, chip: "changes-asked", kind: "reviewAsk", tag: "Changes asked", tone: "back", log: { name: "Review", out: "Changes asked", meta: CHANGE.afterFix } },
  { step: "session", ch: 2, dwell: 2200, via: "address", visit: 1, kind: "address", tag: "Address review 1/3", tone: "back", log: { name: "Address review", out: "visit 1 of 3" } },
  { step: "check", ch: 2, dwell: 1500, sha: CHANGE.approved, kind: "checkPass", tag: "Passed", tone: "good", log: { name: "Check", out: "Passed", meta: CHANGE.approved } },
  { step: "review", ch: 2, dwell: 2000, kind: "reviewOk", tag: "Approved", tone: "good", log: { name: "Review", out: "Approved", meta: CHANGE.approved } },
];

function buildBeats(answers: Answer[]): Beat[] {
  const beats = [...PREFIX];
  let revises = 0;
  let snap: string = CHANGE.approved;
  for (let i = 0; ; i++) {
    const a = answers[i];
    beats.push({ step: "decide", ch: 3, dwell: a ? 1700 : AUTO_SHIP_MS, kind: "decide", pending: !a, tag: "waiting on you", tone: "person", log: { name: "Decide", out: "waiting on a person", meta: snap } });
    if (!a) break;
    if (a === "S") {
      beats.push(
        { step: "decide", ch: 3, dwell: 1300, key: "S", kind: "pressed", tag: "Ship", tone: "person", log: { name: "Decide", out: "Ship", meta: <KeyCap size="xs">S</KeyCap> } },
        { step: "land", ch: 4, dwell: 1600, sub: "rebase", kind: "rebase", tag: "Rebase", tone: "plain", log: { name: "Rebase", out: "onto main" } },
        { step: "land", ch: 4, dwell: 1700, sub: "land", kind: "land", sha: CHANGE.landed, tag: "on main", tone: "plain", log: { name: "Land", out: "on main", meta: CHANGE.landed } },
        { step: "deploy", ch: 5, dwell: 3400, kind: "deploy", tag: "parked", tone: "line", log: { name: "Deploy", out: "Wait for live, parked", meta: "2 targets" } },
        { step: "live", ch: 5, dwell: 0, kind: "live", terminal: true, tag: "web, backend", tone: "line", log: { name: "Live", out: `${CHANGE.landed} on web, backend`, meta: CHANGE.deploys.web } },
      );
      break;
    }
    if (a === "D") {
      beats.push({ step: "decide", ch: 3, dwell: 0, key: "D", end: "dropped", chip: "dropped", terminal: true, kind: "dropped", tag: "Dropped", tone: "bad", log: { name: "Decide", out: "Dropped", meta: <KeyCap size="xs">D</KeyCap> } });
      break;
    }
    if (revises === 3) {
      beats.push({ step: "decide", ch: 3, dwell: 0, key: "R", terminal: true, kind: "cap", tag: "run ends", tone: "bad", log: { name: "Revise", out: "a fourth visit ends the run" } });
      break;
    }
    revises++;
    snap = REVISED[revises - 1];
    beats.push(
      { step: "decide", ch: 3, dwell: 1100, key: "R", chip: "revise", kind: "pressed", tag: "Revise", tone: "person", log: { name: "Decide", out: "Revise", meta: <KeyCap size="xs">R</KeyCap> } },
      { step: "session", ch: 3, dwell: 2000, via: "revise", visit: revises, kind: "revise", tag: `Revise ${revises}/3`, tone: "back", log: { name: "Revise", out: `visit ${revises} of 3` } },
      { step: "check", ch: 3, dwell: 1300, sha: snap, kind: "checkPass", tag: "Passed", tone: "good", log: { name: "Check", out: "Passed", meta: snap } },
      { step: "review", ch: 3, dwell: 1500, kind: "reviewOk", tag: "Approved", tone: "good", log: { name: "Review", out: "Approved", meta: snap } },
    );
  }
  return beats;
}

const SHIP_RUN = buildBeats(["S"]);

/** What lit up to beat `i`. */
function stateAt(beats: Beat[], i: number) {
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

type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
const dist = (a: Pt, b: Pt) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const polyLen = (pts: Pt[]) => pts.slice(1).reduce((n, p, k) => n + dist(pts[k], p), 0);

type Geo = {
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
  tag?: (s: StepId) => Pt;
  already?: string;
  branchArc?: string;
  landCells: (r: Rect) => { rebase: Rect; land: Rect; arrow: Pt; title: Pt };
};

const CHIP_H = 24;

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
    tag: (s) => ({ x: s === "session" ? SX : node[s].x + node[s].w / 2, y: NY - 16 }),
    already: `M${lc.x + chipW(alreadyChip)} ${CHIP_Y + CHIP_H / 2} H${deployX - 22} Q${deployX - 16} ${CHIP_Y + CHIP_H / 2} ${deployX - 16} ${CHIP_Y + 6} V${CY + 6}`,
    branchArc: `M${lc.x + 186} ${NY - 1} C${lc.x + 182} ${NY - 13} ${lc.x + 120} ${NY - 13} ${lc.x + 118} ${NY - 2}`,
    landCells: (r) => ({
      title: { x: r.x + 36, y: r.y + r.h / 2 + 5 },
      rebase: { x: r.x + 86, y: r.y + r.h / 2 - 12, w: 64, h: 24 },
      arrow: { x: r.x + 154, y: r.y + r.h / 2 },
      land: { x: r.x + 164, y: r.y + r.h / 2 - 12, w: 46, h: 24 },
    }),
  };
}

/** Narrow screens: steps stacked, ways out beside each, the rail up the left edge into the Session. */
function vertical(): Geo {
  const W = 340, RX = 12, NX = 30, NW = 132, CHX = 176, GAP = 34, PITCH = 30, SUB = 20;
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
      rebase: { x: r.x + 8, y: r.y + 37, w: 64, h: 24 },
      arrow: { x: r.x + 77, y: r.y + 49 },
      land: { x: r.x + 84, y: r.y + 37, w: 42, h: 24 },
    }),
  };
}

const GEO_H = horizontal();
const GEO_V = vertical();

/** The token's waypoints into beat `i`, and how long each leg takes (fixed per move, so both drawings keep one clock). */
function legs(geo: Geo, beats: Beat[], i: number): { pts: Pt[]; ms: number[]; ease: string } {
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
function travelMs(beats: Beat[], i: number) {
  const b = beats[i];
  const prev = beats[i - 1];
  if (!prev) return 0;
  if (b.via) return LOOP_MS;
  if (b.end) return 700;
  return prev.step === b.step ? 0 : MOVE_MS;
}

// ---------- Drawing ----------

function Icon({ kind, x, y, color }: { kind: Kind; x: number; y: number; color: string }) {
  const p = { fill: "none", stroke: color, strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "shell") {
    return (
      <g {...p}>
        <rect x={x} y={y + 1} width={14} height={12} rx={2.5} />
        <path d={`M${x + 3.5} ${y + 5} l2.5 2 -2.5 2`} />
        <path d={`M${x + 7.5} ${y + 9.5} h3.5`} />
      </g>
    );
  }
  if (kind === "agent") {
    return (
      <g {...p}>
        <rect x={x} y={y + 3} width={14} height={10.5} rx={3} />
        <path d={`M${x + 7} ${y + 3} V${y + 0.5}`} />
        <circle cx={x + 4.8} cy={y + 8.2} r={0.9} fill={color} stroke="none" />
        <circle cx={x + 9.2} cy={y + 8.2} r={0.9} fill={color} stroke="none" />
      </g>
    );
  }
  if (kind === "person") {
    return (
      <g {...p}>
        <circle cx={x + 7} cy={y + 4.5} r={3.2} />
        <path d={`M${x + 1.5} ${y + 14} a5.5 5 0 0 1 11 0`} />
      </g>
    );
  }
  return null;
}

function Node({ geo, id, active, wait, reached, sub, landDone, picked, dim, endTone }: {
  geo: Geo; id: StepId; active: boolean; wait: boolean; reached: boolean; sub?: "rebase" | "land"; landDone: boolean; picked: boolean; dim: boolean; endTone?: Tone;
}) {
  const r = geo.node[id];
  const k = STEPS[id].kind;
  const pill = k === "session" || k === "end";
  const blue = k === "person" || k === "session";
  const live = id === "live";
  const glow = endTone === "bad" ? BAD : blue ? PERSON : LINE;
  const stroke = live ? (reached ? LINE : DIM) : blue ? tint(PERSON, 60) : "rgba(88,110,117,.28)";
  const fill = live ? (reached ? LINE : "transparent") : blue ? "#e8f0f3" : "#fffdf8";
  const ink = blue ? "#1f6fa8" : live ? (reached ? SOL.base3 : MUTED) : INK;
  const cy = id === "land" && geo.vertical ? r.y + 22 : r.y + r.h / 2;
  const cells = id === "land" ? geo.landCells(r) : null;
  return (
    <g className="flx-run-node" data-on={active || undefined} data-wait={wait || undefined} data-pick={picked || undefined} data-dim={dim || undefined} style={{ ["--glow" as string]: glow } as CSSProperties}>
      <rect className="flx-run-box" x={r.x} y={r.y} width={r.w} height={r.h} rx={pill ? r.h / 2 : 10} fill={fill} stroke={stroke} strokeWidth={1.4} strokeDasharray={live && !reached ? "5 4" : undefined} />
      {pill ? (
        <text x={r.x + r.w / 2} y={cy + 5} textAnchor="middle" fontSize={15} fontWeight={650} fill={ink}>{STEPS[id].label}</text>
      ) : (
        <>
          <Icon kind={k} x={r.x + 14} y={cy - 8} color={k === "person" ? PERSON : MUTED} />
          <text x={r.x + 36} y={cy + 5} fontSize={15} fontWeight={700} fill={ink}>{STEPS[id].label}</text>
        </>
      )}
      {cells && (
        <g fontSize={13}>
          {([["rebase", "Rebase", cells.rebase], ["land", "Land", cells.land]] as const).map(([key, label, c]) => {
            const on = sub === key;
            const done = landDone || (key === "rebase" && sub === "land");
            return (
              <g key={key} className="flx-run-sub" data-on={on || undefined} data-done={done || undefined}>
                <rect x={c.x} y={c.y} width={c.w} height={c.h} rx={6} />
                <text x={c.x + c.w / 2} y={c.y + 16.5} textAnchor="middle">{label}</text>
              </g>
            );
          })}
          <path d={`M${cells.arrow.x - 2} ${cells.arrow.y - 3} l3 3 -3 3`} fill="none" stroke={DIM} strokeWidth={1.3} />
        </g>
      )}
    </g>
  );
}

function ChipShape({ geo, c, lit, flash, picked, dim }: { geo: Geo; c: Chip; lit: boolean; flash: boolean; picked: boolean; dim: boolean }) {
  const { x, y } = geo.chipAt(c);
  const color = c.tone === "back" ? BACK : c.tone === "end" ? BAD : MUTED;
  return (
    <g className="flx-run-chip" data-lit={lit || undefined} data-flash={flash || undefined} data-pick={picked || undefined} data-dim={dim || undefined} style={{ ["--c" as string]: color } as CSSProperties}>
      <rect x={x} y={y} width={chipW(c)} height={CHIP_H} rx={c.tone === "end" ? 12 : 6}
        fill={c.tone === "on" ? "#fdfaf1" : c.tone === "end" ? "#fbeee9" : "#f1eff6"}
        stroke={tint(color, c.tone === "on" ? 55 : 45)} strokeDasharray={c.tone === "on" ? "3 3" : undefined} />
      <text x={x + 9} y={y + 16.5} fontSize={CHIP_FONT} fill={c.tone === "on" ? MUTED : color}>{chipLabel(c)}</text>
    </g>
  );
}

/** The token: glides leg by leg with CSS transitions, chained by timers. */
function Token({ geo, beats, beat, animate, still }: { geo: Geo; beats: Beat[]; beat: number; animate: boolean; still: boolean }) {
  const [seg, setSeg] = useState<{ p: Pt; ms: number; ease: string }>({ p: geo.dock(beats[beat].step), ms: 0, ease: "linear" });
  useWatchEffect(() => {
    const { pts, ms, ease } = legs(geo, beats, beat);
    const last = pts[pts.length - 1];
    if (still || !animate || pts.length < 2) { setSeg({ p: last, ms: 0, ease: "linear" }); return; }
    let k = 1;
    let t: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      setSeg({ p: pts[k], ms: ms[k - 1], ease });
      k++;
      if (k < pts.length) t = setTimeout(go, ms[k - 2]);
    };
    go();
    return () => { if (t) clearTimeout(t); };
  }, [beat, beats, animate, still]);
  const b = beats[beat];
  const color = b.tone === "bad" ? BAD : b.via ? BACK : b.step === "decide" || b.step === "session" ? PERSON : LINE;
  return (
    <g className="flx-run-token" style={{ transform: `translate(${seg.p.x}px, ${seg.p.y}px)`, transition: `transform ${seg.ms}ms ${seg.ease}`, ["--tk" as string]: color } as CSSProperties}>
      <circle className="flx-run-halo" r={11} />
      <circle className="flx-run-dot" r={6.5} strokeWidth={2.2} stroke="#fffdf8" />
    </g>
  );
}

function Flow({ geo, beats, beat, animate, still, inspect, onInspect }: {
  geo: Geo; beats: Beat[]; beat: number; animate: boolean; still: boolean; inspect: StepId | null; onInspect: (s: StepId) => void;
}) {
  const b = beats[beat];
  const prev = beats[beat - 1];
  const s = stateAt(beats, beat);
  const moving = animate && !still;
  const dimStep = (step: StepId) => inspect !== null && inspect !== step;
  const landIdx = beats.findIndex((x) => x.sub === "land");
  const landDone = landIdx >= 0 && beat > landIdx;
  const arrowId = geo.vertical ? "flx-run-av" : "flx-run-ah";
  return (
    <div className="relative" style={{ aspectRatio: `${geo.W} / ${geo.H}` }}>
      <svg viewBox={`0 0 ${geo.W} ${geo.H}`} preserveAspectRatio="xMidYMid meet" className="flx-run-svg absolute inset-0 w-full h-full" role="img"
        aria-label="The Change flow: Session, Check, Review, Decide, Land, Deploy, Live, with each step's ways out and the ways back to the Session">
        <defs>
          <marker id={`${arrowId}-g`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
            <path d="M1 1 L7 4 L1 7" fill="none" stroke="rgba(88,110,117,.55)" strokeWidth={1.4} />
          </marker>
          <marker id={`${arrowId}-v`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
            <path d="M1 1 L7 4 L1 7" fill="none" stroke={BACK} strokeWidth={1.4} />
          </marker>
        </defs>

        {/* The rail back to the Session, and each way back's drop to it. */}
        <path d={geo.rail} fill="none" stroke={tint(BACK, 45)} strokeWidth={1.4} markerEnd={`url(#${arrowId}-v)`} />
        {WAYS.map((w) => (
          <path key={w.key} d={geo.drop(w.step)} fill="none" stroke={tint(BACK, 45)} strokeWidth={1.3} strokeDasharray="4 4" />
        ))}
        {/* Loops the change took, drawn as the token travels them. */}
        {WAYS.map((w) => {
          const drawn = s.loops.has(w.key);
          const live = drawn && b.via === w.key && moving;
          const lp = geo.loop(w.step);
          const total = polyLen(lp.pts);
          // The drawn loop starts where the token leaves the box; time it along the same legs.
          let before = 0;
          for (let k = 1; k < lp.pts.length; k++) {
            const a = lp.pts[k - 1], z = lp.pts[k];
            const onSeg = (a.x === z.x && a.x === lp.start.x && (lp.start.y - a.y) * (lp.start.y - z.y) <= 0) || (a.y === z.y && a.y === lp.start.y && (lp.start.x - a.x) * (lp.start.x - z.x) <= 0);
            if (onSeg) { before += dist(a, lp.start); break; }
            before += dist(a, z);
          }
          const drawnLen = total - before - dist(lp.pts[lp.pts.length - 2], lp.pts[lp.pts.length - 1]) * 0.5;
          const delay = (before / total) * LOOP_MS;
          const dur = (drawnLen / total) * LOOP_MS;
          return (
            <path key={`taken-${w.key}`} d={lp.d} pathLength={1} fill="none" stroke={BACK} strokeWidth={2.4} strokeLinejoin="round" strokeDasharray="1 1"
              style={{ strokeDashoffset: drawn ? 0 : 1, transition: live ? `stroke-dashoffset ${dur}ms linear ${delay}ms` : "none" }} />
          );
        })}

        {/* The main line. */}
        {ORDER.slice(1).map((z, i) => {
          const a = ORDER[i];
          const key = `${a}>${z}`;
          const taken = s.edges.has(key);
          const live = taken && !b.via && !b.end && prev?.step === a && b.step === z && moving;
          return (
            <g key={key}>
              <path d={geo.edge(a, z)} stroke="rgba(88,110,117,.35)" strokeWidth={1.3} markerEnd={`url(#${arrowId}-g)`} fill="none" />
              <path d={geo.edge(a, z)} pathLength={1} strokeDasharray="1 1" stroke={LINE} strokeWidth={2.4} fill="none"
                style={{ strokeDashoffset: taken ? 0 : 1, transition: live ? `stroke-dashoffset ${MOVE_MS}ms cubic-bezier(.55,0,.25,1)` : "none" }} />
            </g>
          );
        })}
        {geo.already && (
          <path d={geo.already} fill="none" stroke="rgba(88,110,117,.4)" strokeWidth={1.2} strokeDasharray="3 3" className="flx-run-fadeable" data-dim={dimStep("land") || undefined} />
        )}
        {geo.branchArc && (
          <path d={geo.branchArc} fill="none" stroke="rgba(88,110,117,.5)" strokeWidth={1.2} markerEnd={`url(#${arrowId}-g)`} className="flx-run-fadeable" data-dim={dimStep("land") || undefined}>
            <title>default branch moved: Rebase again</title>
          </path>
        )}

        <Token geo={geo} beats={beats} beat={beat} animate={animate} still={still} />

        {ORDER.map((id) => (
          <Node key={id} geo={geo} id={id} active={b.step === id && !inspect} wait={b.step === id && !!b.pending} reached={id === "live" && b.step === "live"}
            sub={id === "land" && b.step === "land" ? b.sub : undefined} landDone={landDone} picked={inspect === id} dim={dimStep(id)} endTone={b.step === id && b.terminal ? b.tone : undefined} />
        ))}
        {CHIPS.map((c) => (
          <ChipShape key={c.id} geo={geo} c={c} lit={s.lit.has(c.id)} flash={moving && b.chip === c.id} picked={inspect === c.step} dim={dimStep(c.step)} />
        ))}

        {/* Each way back with its visits: a station on the rail, or a line under its chip. */}
        {WAYS.map((w) => {
          const n = s.visits[w.key];
          const text = `${w.label} ${n}/3`;
          const at = geo.wayLabel(w);
          const bumped = moving && b.via === w.key;
          const pw = text.length * 7.2 + 18;
          return (
            <g key={`way-${w.key}`} className="flx-run-way" data-on={n > 0 || undefined} data-pill={at.pill || undefined} data-dim={dimStep(w.step) || undefined}>
              <g key={bumped ? `b${beat}` : "rest"} className={bumped ? "flx-run-bump" : undefined} style={{ ["--d" as string]: `${LOOP_MS * 0.5}ms` } as CSSProperties}>
                {at.pill && <rect x={at.x - pw / 2} y={at.y - 11} width={pw} height={22} rx={11} />}
                <text x={at.x} y={at.pill ? at.y + 4 : at.y} textAnchor={at.anchor} fontSize={geo.vertical ? 12.5 : 12}>{text}</text>
              </g>
            </g>
          );
        })}

        {/* What the active step just did, above it. */}
        {!inspect && geo.tag && (
          <text key={`tag-${beat}-${b.tag}`} className="flx-run-tag" x={geo.tag(b.step).x} y={geo.tag(b.step).y} textAnchor="middle" fontSize={12.5} fontWeight={650} fill={TONE[b.tone]}
            style={{ ["--d" as string]: moving ? `${travelMs(beats, beat)}ms` : "0ms" } as CSSProperties}>
            {b.tag}
          </text>
        )}
      </svg>
      {/* Real buttons over the steps: click one to see its ways out. */}
      {ORDER.map((id) => {
        const r = geo.node[id];
        const pill = STEPS[id].kind === "session" || STEPS[id].kind === "end";
        return (
          <button key={id} type="button" className="flx-run-hit absolute" aria-pressed={inspect === id} aria-label={`Ways out of ${STEPS[id].label}`} onClick={() => onInspect(id)}
            style={{ left: `${(r.x / geo.W) * 100}%`, top: `${(r.y / geo.H) * 100}%`, width: `${(r.w / geo.W) * 100}%`, height: `${(r.h / geo.H) * 100}%`, borderRadius: pill ? 999 : 10 }} />
        );
      })}
    </div>
  );
}

// ---------- The moment panel ----------

function Chiplet({ color, children, dashed = false, solid = false }: { color: string; children: ReactNode; dashed?: boolean; solid?: boolean }) {
  return (
    <span className="inline-flex items-center h-[24px] px-2 rounded-md border font-mono text-[12.5px] whitespace-nowrap"
      style={{ color: solid ? SOL.base3 : color, borderColor: solid ? color : tint(color, 45), backgroundColor: solid ? color : tint(color, 9), borderStyle: dashed ? "dashed" : "solid" }}>
      {children}
    </span>
  );
}

function PanelHead({ title, sub, icon, color = INK, right }: { title: string; sub?: ReactNode; icon?: Kind; color?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 min-w-0">
      {icon && (
        <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0" aria-hidden><Icon kind={icon} x={1} y={1} color={color} /></svg>
      )}
      <span className="font-mono font-bold text-[15px]" style={{ color }}>{title}</span>
      {sub && <span className="font-mono text-[12.5px]" style={{ color: DIM }}>{sub}</span>}
      {right && <span className="ml-auto shrink-0">{right}</span>}
    </div>
  );
}

function Terminal({ lines }: { lines: { t: string; c?: string }[] }) {
  return (
    <div className="mt-3 rounded-lg px-4 py-3 font-mono text-[12.5px] leading-[1.75] overflow-x-auto" style={{ backgroundColor: FLOOR }}>
      {lines.map((l, i) => (
        <div key={i} className="whitespace-pre" style={{ color: l.c ?? SOL.base1 }}>{l.t}</div>
      ))}
    </div>
  );
}

function Visits({ label, n }: { label: string; n: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[12.5px]" style={{ color: BACK }}>
      <span className="font-semibold">{label}</span>
      <span className="flex gap-1" aria-label={`visit ${n} of 3`}>
        {[1, 2, 3].map((k) => (
          <span key={k} className="w-3.5 h-3.5 rounded-[4px] border" style={{ borderColor: tint(BACK, 55), backgroundColor: k <= n ? BACK : "transparent" }} />
        ))}
      </span>
      <span style={{ color: DIM }}>visit {n} of 3</span>
    </div>
  );
}

function Note({ who, color, children }: { who: string; color: string; children: ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border-l-[3px] px-3.5 py-2.5 text-[14px] leading-6" style={{ borderColor: color, backgroundColor: tint(color, 7), color: TEXT }}>
      <div className="font-mono text-[12px] mb-0.5" style={{ color }}>{who}</div>
      {children}
    </div>
  );
}

function Arrow({ children, color = DIM }: { children: ReactNode; color?: string }) {
  return (
    <div className="mt-3 flex items-center gap-2 font-mono text-[12.5px]" style={{ color }}>
      <svg width={18} height={10} viewBox="0 0 18 10" className="shrink-0" aria-hidden><path d="M1 5 H15 M11 1.5 L15 5 L11 8.5" fill="none" stroke="currentColor" strokeWidth={1.4} /></svg>
      <span>{children}</span>
    </div>
  );
}

function Stats({ items }: { items: [string, ReactNode, string?][] }) {
  return (
    <div className="mt-3 grid grid-cols-3 gap-1.5 font-mono">
      {items.map(([k, v, c]) => (
        <div key={k} className="rounded-md border px-2.5 py-2 min-w-0" style={{ borderColor: HAIR, backgroundColor: "#fffdf8" }}>
          <div className="text-[11.5px]" style={{ color: DIM }}>{k}</div>
          <div className="text-[14px] font-semibold tabular-nums" style={{ color: c ?? INK }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function SessionCard({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 rounded-lg border px-3.5 py-3" style={{ borderColor: tint(PERSON, 40), backgroundColor: "#f1f5f4" }}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[12.5px]">
        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: PERSON }} />
        <span className="font-semibold" style={{ color: INK }}>Your session</span>
        <span style={{ color: DIM }}>{CHANGE.session}, where the change was made</span>
      </div>
      {children}
    </div>
  );
}

const CHECK_HEAD = [{ t: "$ bun run check" }, { t: "tsc        0 errors", c: SOL.base0 }, { t: "eslint     0 problems", c: SOL.base0 }, { t: "bun test" }];
const CHECK_FAIL = "total.test.ts › empty cart totals 0";
const CHECK_WHY = "TypeError: items[0] is undefined";
const REVIEW_ASK = "checkout.ts still reads items[0] when the cart is empty. Guard it there too.";

const TARGETS = ["web", "backend", "cli", "mobile", "desktop"] as const;
const touched = (t: string) => (CHANGE.targets as readonly string[]).includes(t);

/** The deploy targets on one line: the touched ones lit, the rest named and passed over. */
function Targets({ live }: { live: boolean }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-[12.5px]">
      {TARGETS.map((t) =>
        touched(t) ? (
          <span key={t} className="inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-md border" style={{ color: live ? SOL.base3 : "#1d7d76", borderColor: LINE, backgroundColor: live ? LINE : tint(LINE, 10) }}>
            {!live && <span className="flx-run-wait w-1.5 h-1.5 rounded-full" style={{ backgroundColor: LINE }} />}
            <b className="font-semibold">{t}</b>
            <span>{live ? CHANGE.deploys[t as keyof typeof CHANGE.deploys] : "waiting"}</span>
          </span>
        ) : (
          <span key={t} className="inline-flex items-center h-[26px] px-2 rounded-md border border-dashed line-through decoration-1" style={{ color: DIM, borderColor: HAIR }} title="no paths touched">{t}</span>
        ),
      )}
    </div>
  );
}

function DecideCard({ beat, onAnswer, paused, lap }: { beat: Beat; onAnswer?: (a: Answer) => void; paused: boolean; lap: number }) {
  const opts: [Answer, string, string, string][] = [
    ["S", "Ship", "Land the change", PERSON],
    ["R", "Revise", "Your note goes back to the session that made it", BACK],
    ["D", "Drop", "Leave the change unshipped", BAD],
  ];
  const live = !!beat.pending && !!onAnswer;
  return (
    <div className="mt-3 rounded-xl border overflow-hidden" style={{ borderColor: tint(PERSON, 45), backgroundColor: "#fbfcfb" }}>
      <div className="px-4 pt-3 pb-2.5 border-b" style={{ borderColor: tint(PERSON, 20) }}>
        <div className="font-mono font-semibold text-[14px]" style={{ color: INK }}>{CHANGE.title}</div>
        <div className="text-[13.5px] mt-0.5" style={{ color: MUTED }}>It passed its checks and review.</div>
      </div>
      <div className="p-2 grid gap-1">
        {opts.map(([k, label, desc, c]) => {
          const on = beat.key === k;
          return (
            <button key={k} type="button" disabled={!live} onClick={() => onAnswer?.(k)}
              className={`flx-run-opt relative flex items-center gap-3 rounded-lg px-2.5 py-2 text-left overflow-hidden ${on ? "flx-run-press" : ""}`}
              style={{ ["--oc" as string]: c, backgroundColor: on ? tint(c, 13) : undefined, boxShadow: on ? `inset 0 0 0 1.5px ${tint(c, 60)}` : undefined } as CSSProperties}>
              <KeyCap>{k}</KeyCap>
              <span className="font-mono font-semibold text-[13.5px] w-[56px] shrink-0" style={{ color: on ? c : INK }}>{label}</span>
              <span className="text-[13.5px] min-w-0" style={{ color: MUTED }}>{desc}</span>
              {live && k === "S" && (
                <span key={lap} className="flx-run-auto absolute left-0 bottom-0 h-[2px]" style={{ backgroundColor: PERSON, ["--ms" as string]: `${AUTO_SHIP_MS}ms`, animationPlayState: paused ? "paused" : "running" } as CSSProperties} aria-hidden />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Moment({ beats, beat, onAnswer, paused, lap }: { beats: Beat[]; beat: number; onAnswer: (a: Answer) => void; paused: boolean; lap: number }) {
  const b = beats[beat];
  const snapBefore = [...beats.slice(0, beat + 1)].reverse().find((x) => x.sha && x.sha !== CHANGE.landed)?.sha ?? CHANGE.frozen;
  switch (b.kind) {
    case "freeze":
      return (
        <>
          <PanelHead title="Your session" sub={PROBLEM.title} color="#1f6fa8" right={<Chiplet color={MUTED}>{CHANGE.task}</Chiplet>} />
          <div className="mt-3 rounded-lg border font-mono text-[12.5px]" style={{ borderColor: HAIR, backgroundColor: "#fffdf8" }}>
            {CHANGE.files.map((f, i) => (
              <div key={f} className="flex items-center gap-3 px-3 h-8 border-b last:border-b-0" style={{ borderColor: HAIR }}>
                <span className="min-w-0 flex-1 break-all" style={{ color: TEXT }}>{f.replace(/^packages\//, "")}</span>
                <span style={{ color: GOOD }}>{i ? "+6" : "+14"}</span>
                <span className="w-6 text-right" style={{ color: BAD }}>{i ? "−1" : "−3"}</span>
              </div>
            ))}
          </div>
          <Arrow color={LINE}>frozen into a commit</Arrow>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chiplet color={LINE}>{CHANGE.frozen}</Chiplet>
            <Chiplet color={MUTED}>{CHANGE.branch}</Chiplet>
            <Chiplet color={MUTED} dashed>shared checkout untouched</Chiplet>
          </div>
        </>
      );
    case "checkFail":
      return (
        <>
          <PanelHead title="Check" sub="Verify" icon="shell" right={<Chiplet color={LINE}>{CHANGE.frozen}</Chiplet>} />
          <Terminal lines={[...CHECK_HEAD, { t: `✗ ${CHECK_FAIL}`, c: "#f0776f" }, { t: `  ${CHECK_WHY}` }, { t: "1 failed · 214 passed · 41s", c: SOL.base0 }]} />
          <Arrow color={BACK}>Checks failed: Fix check, in the same session</Arrow>
        </>
      );
    case "fix":
      return (
        <>
          <PanelHead title="Fix check" sub="a way back" color={BACK} right={<Chiplet color={BACK}>1 of 3</Chiplet>} />
          <SessionCard>
            <Note who="Check" color={BAD}>{CHECK_FAIL}: {CHECK_WHY}</Note>
            <div className="mt-3"><Visits label="Fix check" n={1} /></div>
          </SessionCard>
          <Arrow color={BACK}>back to Check on a new snapshot</Arrow>
        </>
      );
    case "checkPass":
      return (
        <>
          <PanelHead title="Check" sub="Verify" icon="shell" right={<Chiplet color={GOOD}>Passed</Chiplet>} />
          <Terminal lines={[...CHECK_HEAD, { t: `✓ 215 passed · 43s`, c: "#a7b84a" }]} />
          <Arrow color={LINE}>{b.sha}, a fresh snapshot, goes to Review</Arrow>
        </>
      );
    case "reviewAsk":
      return (
        <>
          <PanelHead title="Review" sub="an independent session" icon="agent" right={<Chiplet color={BACK}>↺ Changes asked</Chiplet>} />
          <Stats items={[["reviews", snapBefore, LINE], ["files", "2"], ["changed", "+20 −4"]]} />
          <Note who="reviewer" color={BACK}>{REVIEW_ASK}</Note>
          <Arrow color={BACK}>Address review, in the same session</Arrow>
        </>
      );
    case "address":
      return (
        <>
          <PanelHead title="Address review" sub="a way back" color={BACK} right={<Chiplet color={BACK}>1 of 3</Chiplet>} />
          <SessionCard>
            <Note who="reviewer" color={BACK}>{REVIEW_ASK}</Note>
            <div className="mt-3"><Visits label="Address review" n={1} /></div>
          </SessionCard>
          <Arrow color={BACK}>back to Check: the whole path runs again</Arrow>
        </>
      );
    case "reviewOk":
      return (
        <>
          <PanelHead title="Review" sub="an independent session" icon="agent" right={<Chiplet color={GOOD}>Approved</Chiplet>} />
          <Stats items={[["reviews", snapBefore, LINE], ["files", "2"], ["changed", "+24 −4"]]} />
          <Note who="reviewer" color={GOOD}>Both totals return 0 for an empty cart, with a test for each.</Note>
          <Arrow color={PERSON}>{snapBefore} goes to Decide</Arrow>
        </>
      );
    case "decide":
    case "pressed":
    case "dropped":
    case "cap": {
      const ended = b.kind === "dropped" || b.kind === "cap";
      return (
        <>
          <PanelHead title="Decide" sub="a person" icon="person" color={PERSON}
            right={<Chiplet color={b.tone === "bad" ? BAD : b.key === "R" ? BACK : PERSON} solid={ended}>{b.kind === "decide" ? "waiting on you" : b.kind === "cap" ? "run ended" : b.tag}</Chiplet>} />
          <DecideCard beat={b} onAnswer={onAnswer} paused={paused} lap={lap} />
          {b.kind === "decide" && <Arrow color={PERSON}>press a key, or it ships</Arrow>}
          {b.kind === "dropped" && <Arrow color={BAD}>the run ends; the change stays unshipped</Arrow>}
          {b.kind === "cap" && <Arrow color={BAD}>Revise has had its 3 visits; a fourth ends the run</Arrow>}
        </>
      );
    }
    case "revise":
      return (
        <>
          <PanelHead title="Revise" sub="a way back" color={BACK} right={<Chiplet color={BACK}>{b.visit} of 3</Chiplet>} />
          <SessionCard>
            <Note who="your note" color={PERSON}>Show the empty total as $0.00 on the receipt too.</Note>
            <div className="mt-3"><Visits label="Revise" n={b.visit ?? 1} /></div>
          </SessionCard>
          <Arrow color={BACK}>back to Check on a new snapshot</Arrow>
        </>
      );
    case "rebase":
    case "land": {
      const done = b.kind === "land";
      return (
        <>
          <PanelHead title="Land" sub="2 steps" icon="shell" />
          <div className="mt-3 grid gap-1.5 font-mono text-[12.5px]">
            {([["Rebase", "onto main, clean", true], ["Land", done ? `${CHANGE.landed} on main` : "next", done]] as const).map(([name, out, ok]) => (
              <div key={name} className="flex items-center gap-3 rounded-md px-3 h-9 border" style={{ borderColor: ok ? tint(LINE, 40) : HAIR, backgroundColor: ok ? tint(LINE, 7) : "transparent" }}>
                <span className="w-4 text-center" style={{ color: ok ? LINE : DIM }}>{ok ? "✓" : "·"}</span>
                <span className="w-16 font-semibold" style={{ color: INK }}>{name}</span>
                <span style={{ color: ok ? TEXT : DIM }}>{out}</span>
              </div>
            ))}
          </div>
          <Stats items={[["Review approved", snapBefore, GOOD], ["Decide accepted", snapBefore, PERSON], ["lands as", done ? CHANGE.landed : "·······", done ? LINE : DIM]]} />
        </>
      );
    }
    case "deploy":
      return (
        <>
          <PanelHead title="Deploy" sub="Wait for live" icon="shell" right={<Chiplet color={LINE}>parked</Chiplet>} />
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Chiplet color={MUTED}>holds no slot</Chiplet>
            <Chiplet color={MUTED}>holds no session</Chiplet>
            <Chiplet color={MUTED}>waits up to 7 days</Chiplet>
          </div>
          <Targets live={false} />
          <Arrow color={LINE}>waits only for the targets whose paths it touches</Arrow>
        </>
      );
    default:
      return (
        <>
          <PanelHead title="Live" color="#1d7d76" right={<Chiplet color={LINE} solid>run complete</Chiplet>} />
          <Terminal lines={[
            { t: `Live: ${CHANGE.landed} on web ${CHANGE.deploys.web}`, c: "#5fd0c6" },
            { t: `Live: ${CHANGE.landed} on backend ${CHANGE.deploys.backend}`, c: "#5fd0c6" },
          ]} />
          <Targets live />
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 font-mono text-[12.5px]" style={{ borderColor: HAIR, backgroundColor: "#fffdf8" }}>
            <span style={{ color: DIM }}>next</span>
            <span className="font-semibold" style={{ color: INK }}>{CHANGE.task} watched</span>
            <span style={{ color: TEXT }}>{CHANGE.liveOn} to {CHANGE.watchUntil}</span>
            <a href="#ship" className="ml-auto underline underline-offset-4" style={{ color: "#1d7d76", textDecorationColor: tint(LINE, 60) }}>Ship and watch</a>
          </div>
        </>
      );
  }
}

function WaysOut({ step, onClose }: { step: StepId; onClose: () => void }) {
  const k = STEPS[step].kind;
  const color: Record<ChipTone | "go" | "ok", string> = { go: LINE, ok: GOOD, back: BACK, end: BAD, on: MUTED };
  const way = WAYS.find((w) => w.step === step);
  return (
    <>
      <PanelHead title={STEPS[step].label} sub="ways out" icon={k === "session" || k === "end" ? undefined : k} color={k === "person" || k === "session" ? PERSON : INK}
        right={<button type="button" onClick={onClose} className="flx-run-btn font-mono text-[12.5px] px-2.5 h-7 rounded-md border" style={{ borderColor: HAIR, color: TEXT }}>back to the run</button>} />
      <div className="mt-3 grid gap-2">
        {WAYS_OUT[step].map((w) => (
          <div key={w.out} className="flex items-center gap-x-3 gap-y-1 font-mono text-[12.5px] flex-wrap">
            <Chiplet color={color[w.tone]} dashed={w.tone === "on"}>{w.tone === "back" ? `↺ ${w.out}` : w.out}</Chiplet>
            <svg width={16} height={10} viewBox="0 0 16 10" aria-hidden><path d="M1 5 H13 M9.5 1.5 L13 5 L9.5 8.5" fill="none" stroke={DIM} strokeWidth={1.3} /></svg>
            <span style={{ color: TEXT }}>{w.to}</span>
          </div>
        ))}
      </div>
      {way && <div className="mt-4"><Visits label={way.label} n={0} /></div>}
      {step === "deploy" && <div className="mt-4 font-mono text-[12.5px]" style={{ color: DIM }}>parks · holds no slot or session · up to 7 days</div>}
    </>
  );
}

/** Every snapshot the run checked: each way back makes a new one, and the approved one lands. */
function Snapshots({ beats, beat }: { beats: Beat[]; beat: number }) {
  const shown = beats.map((b, i) => ({ b, i })).filter(({ b }) => b.sha);
  const notes: Record<string, string> = { [CHANGE.frozen]: "frozen", [CHANGE.afterFix]: "after Fix check", [CHANGE.approved]: "after Address review", [CHANGE.landed]: "landed on main" };
  const approvedAt = (i: number) => beats.slice(i + 1).find((x) => x.sha || x.kind === "reviewOk")?.kind === "reviewOk";
  let current = -1;
  shown.forEach(({ i }, k) => { if (i <= beat) current = k; });
  return (
    <div className="mt-auto pt-5">
      <div className="pt-4 border-t border-dashed flex flex-wrap items-center gap-x-2 font-mono text-[12px]" style={{ borderColor: HAIR, color: DIM }}>
        <span className="font-semibold" style={{ color: TEXT }}>Snapshots</span>
        <span>each way back checks a new one</span>
      </div>
      <ol className="mt-2.5 flex flex-wrap gap-x-2 gap-y-3 font-mono">
        {shown.map(({ b, i }, k) => {
          const on = i <= beat;
          const now = k === current;
          const landed = b.sha === CHANGE.landed;
          const c = landed ? LINE : k === 0 ? PERSON : BACK;
          const note = landed ? notes[b.sha!] : approvedAt(i) && beat > i + 1 ? "approved" : notes[b.sha!] ?? "after Revise";
          return (
            <li key={`${b.sha}-${i}`} className="flex items-start gap-2">
              <div>
                <span className="h-[24px] inline-flex items-center gap-1.5 px-2 rounded-md text-[12.5px] transition-colors"
                  style={{ color: on ? (landed ? SOL.base3 : c) : DIM, backgroundColor: on ? (landed ? LINE : tint(c, now ? 16 : 9)) : "transparent", border: `1px ${on ? "solid" : "dashed"} ${on ? tint(c, now ? 80 : 40) : HAIR}`, boxShadow: now ? `0 0 0 3px ${tint(c, 14)}` : undefined }}>
                  <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden><circle cx={5} cy={5} r={3} fill="none" stroke="currentColor" strokeWidth={1.5} /></svg>
                  {on ? b.sha : "·······"}
                </span>
                <div className="mt-1 text-[11.5px]" style={{ color: on ? MUTED : DIM }}>{on ? note : "next"}</div>
              </div>
              {k < shown.length - 1 && <span className="mt-[12px] w-4 h-px shrink-0" style={{ backgroundColor: on ? tint(BACK, 50) : HAIR }} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Log({ beats, beat, ghosts }: { beats: Beat[]; beat: number; ghosts: number }) {
  return (
    <ol className="font-mono text-[12.5px]" aria-label="Run log">
      {Array.from({ length: Math.max(beats.length, ghosts) }, (_, i) => {
        const b = beats[i];
        const on = !!b && i <= beat;
        return (
          <li key={i} className="flx-run-row flex items-center gap-2.5 min-h-[27px] px-2 rounded-md" data-on={on || undefined} data-now={(on && i === beat) || undefined}>
            <span className="w-5 shrink-0 tabular-nums text-[11.5px]" style={{ color: DIM }}>{String(i + 1).padStart(2, "0")}</span>
            {on ? (
              <>
                <span className="font-semibold shrink-0" style={{ color: b.via ? BACK : b.step === "decide" || b.step === "session" ? PERSON : INK }}>{b.log.name}</span>
                <span className="min-w-0" style={{ color: TONE[b.tone] }}>{b.log.out}</span>
                {b.log.meta && <span className="ml-auto shrink-0 text-[12px]" style={{ color: b.via ? BACK : MUTED }}>{b.log.meta}</span>}
              </>
            ) : (
              <span className="flx-run-ghost h-[3px] rounded-full" style={{ width: `${30 + ((i * 37) % 45)}%`, backgroundColor: HAIR }} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- The player ----------

function PlayIcon({ mode }: { mode: "play" | "pause" | "replay" }) {
  if (mode === "pause") return <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden><rect x={2} y={1.5} width={2.8} height={9} rx={0.8} fill="currentColor" /><rect x={7.2} y={1.5} width={2.8} height={9} rx={0.8} fill="currentColor" /></svg>;
  if (mode === "play") return <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden><path d="M3 1.5 L10.5 6 L3 10.5 Z" fill="currentColor" /></svg>;
  return <svg width={13} height={13} viewBox="0 0 14 14" aria-hidden><path d="M3.2 4.2 A5 5 0 1 1 2.2 8" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /><path d="M1.5 1.8 V5 H4.7" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ChangeRun() {
  const still = useStill();
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const inView = useNearViewport(ref, "0px", { latch: false });
  // Before it plays: the finished Ship run.
  const [answers, setAnswers] = useState<Answer[]>(["S"]);
  const [beat, setBeat] = useState(SHIP_RUN.length - 1);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [inspect, setInspect] = useState<StepId | null>(null);
  const [lap, setLap] = useState(0); // restarts the current beat's clock on resume

  const beats = useMemo(() => buildBeats(answers), [answers]);
  const last = beats.length - 1;
  const b = beats[beat] ?? beats[last];
  const halted = paused || !!inspect;

  useWatchEffect(() => {
    if (still || !playing || started) return;
    const t = setTimeout(() => { setStarted(true); setAnswers([]); setAnimate(false); setBeat(0); }, 250);
    return () => clearTimeout(t);
  }, [playing, still, started]);

  const answer = (a: Answer) => {
    if (!b.pending) return;
    setAnswers((xs) => [...xs, a]);
    setAnimate(true);
    setBeat(beat + 1);
  };

  const beatMs = (animate ? travelMs(beats, beat) : 0) + b.dwell;
  useWatchEffect(() => {
    if (still || !started || halted || b.terminal) return;
    const t = setTimeout(() => {
      if (b.pending) return answer("S");
      if (beat < last) { setAnimate(true); setBeat(beat + 1); }
    }, beatMs);
    return () => clearTimeout(t);
  }, [beat, beats, halted, started, still, lap]);

  // At Decide the real keys answer while the figure is on screen.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!b.pending || !inView || !started || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    const k = e.key.toUpperCase();
    if (k === "S" || k === "R" || k === "D") { e.preventDefault(); setInspect(null); setPaused(false); answer(k); }
  });

  const go = (nextAnswers: Answer[], i: number) => {
    setInspect(null); setAnimate(false); setStarted(true); setPaused(false);
    setAnswers(nextAnswers); setBeat(i); setLap((n) => n + 1);
  };
  // Jumping back to Decide or before asks again; jumping past it takes Ship.
  const jump = (c: number) => {
    const next = c <= 3 ? [] : ["S" as Answer];
    go(next, buildBeats(next).findIndex((x) => x.ch === c));
  };
  const done = !started || !!b.terminal;
  const mode: "play" | "pause" | "replay" = done ? "replay" : halted ? "play" : "pause";
  const onPlay = () => {
    if (mode === "replay") return go([], 0);
    if (mode === "play") { setInspect(null); setPaused(false); setLap((n) => n + 1); return; }
    setPaused(true);
  };
  const onInspect = (s: StepId) => {
    if (inspect === s) { setInspect(null); setLap((n) => n + 1); return; }
    setInspect(s);
  };

  const ch = b.ch;
  const status = b.kind === "live" ? "Live" : b.kind === "cap" ? "Revise · run ends" : `${STEPS[b.step].label} · ${b.tag}`;
  const ghosts = b.terminal ? 0 : buildBeats([...answers, ...(b.pending || !answers.includes("S") ? ["S" as Answer] : [])]).length;
  const flowProps = { beats, beat, animate, still, inspect, onInspect };
  return (
    <div ref={ref} className="flx-run-fig rounded-2xl border overflow-hidden" data-play={playing && !still ? "" : undefined} style={{ borderColor: HAIR, backgroundColor: PAPER, boxShadow: "0 30px 60px -44px rgba(0,43,54,.55)" }}>
      {/* The run's identity, status and controls. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:px-5 py-3 border-b" style={{ borderColor: HAIR }}>
        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: TONE[b.tone] }} />
        <span className="font-mono font-semibold text-[14px]" style={{ color: INK }}>{CHANGE.title}</span>
        <Chiplet color={MUTED}>{CHANGE.task}</Chiplet>
        <Chiplet color={LINE}>Change</Chiplet>
        <span className="ml-auto flex items-center gap-3">
          <span key={status} className="flx-run-status font-mono text-[12.5px]" style={{ color: TONE[b.tone] }}>{status}</span>
          <button type="button" onClick={onPlay} className="flx-run-btn inline-flex items-center gap-2 h-8 px-3 rounded-lg border font-mono text-[12.5px]" style={{ borderColor: HAIR, color: INK }} aria-label={mode === "pause" ? "Pause the run" : mode === "play" ? "Play the run" : "Replay the run"}>
            <PlayIcon mode={mode} />
            <span>{mode === "pause" ? "Pause" : mode === "play" ? "Play" : "Replay"}</span>
          </button>
        </span>
      </div>

      {/* Chapters: each a jump. Played ones carry a check, the current one fills; a finished run shows them all done. */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 px-4 sm:px-5 pt-3">
        {CHAPTERS.map((name, c) => {
          const inCh = beats.filter((x) => x.ch === c);
          const first = beats.findIndex((x) => x.ch === c);
          const reached = first >= 0 && first <= beat;
          const state = b.terminal ? (reached ? (b.tone === "bad" && c === ch ? "ended" : "played") : "skipped") : c < ch ? "played" : c === ch ? "now" : "ahead";
          const count = Math.max(inCh.length, 1);
          const pos = beat - first;
          const from = state === "now" ? (pos / count) * 100 : state === "played" || state === "ended" ? 100 : 0;
          const to = state === "now" ? ((pos + 1) / count) * 100 : from;
          const moving = state === "now" && started && !still && !b.pending;
          return (
            <button key={name} type="button" onClick={() => jump(c)} aria-current={state === "now" ? "step" : undefined}
              className="flx-run-btn flx-run-chap text-left rounded-md px-2 pt-1.5 pb-2" data-state={state}>
              <span className="flex items-center gap-1.5 font-mono text-[12.5px]">
                <span className="flx-run-chap-n inline-flex items-center justify-center w-[18px] h-[18px] rounded-full text-[11px] tabular-nums shrink-0">
                  {state === "played" ? (
                    <svg width={9} height={9} viewBox="0 0 10 10" aria-hidden><path d="M1.5 5.2 L4 7.6 L8.5 2.6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></svg>
                  ) : c + 1}
                </span>
                <span className="flx-run-chap-name">{name}</span>
              </span>
              <span className="flx-run-chap-bar mt-1.5 block rounded-full overflow-hidden">
                <span key={moving ? `${beat}-${lap}` : "rest"} className={`block h-full rounded-full ${moving ? "flx-run-fill" : ""}`}
                  style={{ width: `${to}%`, ["--from" as string]: `${from}%`, ["--ms" as string]: `${beatMs}ms`, animationPlayState: halted ? "paused" : "running" } as CSSProperties} />
              </span>
            </button>
          );
        })}
      </div>

      {/* Wide: the flow across the top, then the moment and the log side by side.
          Narrower: the flow stacked vertically on the left (or on top on a phone), the moment and log beside it. */}
      <div className="hidden xl:block px-5 pt-4 pb-3">
        <Flow geo={GEO_H} {...flowProps} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,360px)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)] mt-2 xl:mt-0">
        <div className="xl:hidden px-4 sm:px-5 pt-3 pb-5 md:border-r" style={{ borderColor: HAIR }}>
          <div className="mx-auto max-w-[400px]"><Flow geo={GEO_V} {...flowProps} /></div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_380px] border-t" style={{ borderColor: HAIR }}>
          <div className="p-4 sm:p-5 flex flex-col">
            <div key={inspect ? `i-${inspect}` : `b-${beat}-${b.kind}`} className="flx-run-moment" aria-live="polite">
              {inspect ? <WaysOut step={inspect} onClose={() => onInspect(inspect)} /> : <Moment beats={beats} beat={beat} onAnswer={(a) => { setPaused(false); answer(a); }} paused={halted} lap={lap} />}
            </div>
            <Snapshots beats={beats} beat={beat} />
          </div>
          <div className="p-3 sm:p-4 border-t xl:border-t-0 xl:border-l" style={{ borderColor: HAIR, backgroundColor: "#fbf6e8" }}>
            <div className="flex items-center gap-2 px-2 pb-2 font-mono text-[12.5px]" style={{ color: DIM }}>
              <span className="font-semibold" style={{ color: TEXT }}>Run log</span>
              <span className="ml-auto tabular-nums">{beat + 1} / {b.terminal ? beats.length : ghosts}</span>
            </div>
            <Log beats={beats} beat={beat} ghosts={ghosts} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChangeRunSection() {
  return (
    <Section
      id="checks"
      tone="plain"
      wide
      title="Check, Review, Decide, then Land"
      lede={
        <>
          <p>A change written by hand passes the same <b>Check</b>, <b>Review</b> and <b>Decide</b> as one an agent wrote overnight.</p>
          <p>
            Every way back runs in the session the change came from and returns to Check, so the whole path runs again on a fresh snapshot, with 3 visits each. What lands is exactly what Review approved and Decide accepted. At Decide, press a key.
          </p>
        </>
      }
    >
      <ChangeRun />
    </Section>
  );
}
