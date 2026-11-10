/**
 * Human-like pointer and key timing for input sent to the human's Chrome.
 *
 * CDP input teleports: one mouseMoved straight to the exact centre of the
 * target, then a press and release a millisecond apart, and keys as fast as
 * the socket carries them. Behavioural bot detection (reCAPTCHA v3,
 * Cloudflare, DataDome, HUMAN) scores exactly that, and the human's own
 * Chrome carries their accounts, so a flagged session costs them. This module
 * sits in front of each Input.dispatchMouseEvent / Input.dispatchKeyEvent and
 * first sends what a hand would have: a curved, eased path from where the
 * pointer last was (a cubic Bezier bowed to one side, minimum-jerk velocity,
 * ~60-120 Hz samples, a little tremor, an occasional overshoot), timed by
 * distance (Fitts' law); a brief settle before pressing, a 60-140 ms press,
 * and 30-110 ms between keys. The caller's own event then goes out with its
 * semantics untouched; only its x/y move a pixel or two off dead centre.
 *
 * The model is OpenCode browse's (execute/human-input.ts), which runs in its
 * relay the same way: here it is called by the bridge host for the real
 * Chrome (bridge/host.ts). The managed clone, through the engine or the
 * built-in driver, is unaffected, so nothing slows that path.
 *
 * Off by default: it costs about a second a click, and most pages do not
 * score input. It turns on by itself for a tab where challenge detection saw
 * a bot check (challenge.ts; the CLI lists the tab with markChallengedTab),
 * since that site is plainly scoring. The shared config's
 * `browser.human_input: true` turns it on for every tab and `false` keeps it
 * off even there; `CAST_BROWSER_HUMAN_INPUT` (1/on or 0/off) does the same for
 * a process. Even on, only the first KEY_PACED_BURST keys of a burst are
 * paced, so a long `type` costs a few seconds, never one gap per character.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { readSharedConfig } from "../config/sharedConfig.js";
import { defaultConfigDir } from "../config/configDir.js";

export type Point = { x: number; y: number };
export type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** The explicit choice: the env override when set, else the machine
 *  setting; undefined when neither says, which means "only on challenged
 *  tabs". */
export function humanInputChoice(env: NodeJS.ProcessEnv = process.env, setting: () => boolean | undefined = machineSetting): boolean | undefined {
  const v = env.CAST_BROWSER_HUMAN_INPUT?.trim();
  if (v) return !/^(0|false|off|no)$/i.test(v);
  return setting();
}

/** Whether input to this tab is paced: the explicit choice, else whether the
 *  tab met a bot check. */
export function humanInputEnabled(
  tabKey: string | number,
  env: NodeJS.ProcessEnv = process.env,
  setting: () => boolean | undefined = machineSetting,
  challenged: (tabKey: string | number) => boolean = isChallengedTab,
): boolean {
  return humanInputChoice(env, setting) ?? challenged(tabKey);
}

/** How long a tab stays paced after its bot check was seen. */
export const CHALLENGED_TTL_MS = 2 * 60 * 60_000;

function challengedFile(): string {
  return path.join(defaultConfigDir(), "browser", "challenged-tabs.json");
}

function readChallenged(): Record<string, number> {
  try {
    const v = JSON.parse(fs.readFileSync(challengedFile(), "utf-8"));
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Called by the CLI when challenge detection fires on a real-Chrome tab (the
 *  bridge host's numeric tab id). Best effort: losing it costs pacing, never
 *  correctness. */
export function markChallengedTab(tabId: number, now = Date.now()): void {
  const live = Object.fromEntries(Object.entries(readChallenged()).filter(([, until]) => until > now));
  live[String(tabId)] = now + CHALLENGED_TTL_MS;
  try {
    fs.mkdirSync(path.dirname(challengedFile()), { recursive: true });
    const tmp = `${challengedFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(live));
    fs.renameSync(tmp, challengedFile());
  } catch {
    /* courtesy only */
  }
}

let challengedCache: { at: number; value: Record<string, number> } | null = null;
function isChallengedTab(tabKey: string | number): boolean {
  if (!challengedCache || Date.now() - challengedCache.at >= 5_000) challengedCache = { at: Date.now(), value: readChallenged() };
  return (challengedCache.value[String(tabKey)] ?? 0) > Date.now();
}

let cached: { at: number; value: boolean | undefined } | null = null;
/** Read at most every few seconds: the bridge host is long-lived and input is frequent. */
function machineSetting(): boolean | undefined {
  if (cached && Date.now() - cached.at < 5_000) return cached.value;
  let value: boolean | undefined;
  try {
    const v = readSharedConfig(defaultConfigDir()).browser?.human_input;
    value = typeof v === "boolean" ? v : undefined;
  } catch {
    value = undefined;
  }
  cached = { at: Date.now(), value };
  return value;
}

type Rand = () => number;
const between = (rand: Rand, min: number, max: number) => min + rand() * (max - min);
/** Normal-ish noise (sum of uniforms), mean 0. */
const noise = (rand: Rand, scale: number) => (rand() + rand() + rand() - 1.5) * scale;
/** Minimum-jerk position profile: slow start, fast middle, slow arrival. */
const minimumJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** Longest a single movement takes, whatever the distance. */
export const MAX_MOVE_MS = 1100;

/** Points (each with the delay before it) for one movement from `from` to
 *  `to`, ending just short of `to`: the caller's own event lands there. */
export function trajectory(from: Point, to: Point, rand: Rand = Math.random): Array<{ point: Point; delay: number }> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return [];
  // Fitts' law with a ~40px target, plus personal variation.
  const duration = Math.min(MAX_MOVE_MS, (90 + 110 * Math.log2(distance / 40 + 1)) * between(rand, 0.85, 1.25));
  // Bow the path to one side, never past ~18% of the distance.
  const normal = { x: -dy / distance, y: dx / distance };
  const bow = (rand() < 0.5 ? -1 : 1) * between(rand, 0.04, 0.18) * distance;
  const c1 = { x: from.x + dx * between(rand, 0.2, 0.35) + normal.x * bow, y: from.y + dy * between(rand, 0.2, 0.35) + normal.y * bow };
  const c2 = { x: from.x + dx * between(rand, 0.65, 0.8) + normal.x * bow * 0.6, y: from.y + dy * between(rand, 0.65, 0.8) + normal.y * bow * 0.6 };
  // Long moves sometimes overshoot slightly and come back.
  const overshoot = distance > 250 && rand() < 0.25;
  const end = overshoot ? { x: to.x + (dx / distance) * between(rand, 4, 12), y: to.y + (dy / distance) * between(rand, 4, 12) } : to;
  const points: Array<{ point: Point; delay: number }> = [];
  let elapsed = 0;
  while (elapsed < duration) {
    const step = between(rand, 8, 17);
    elapsed = Math.min(duration, elapsed + step);
    const s = minimumJerk(elapsed / duration);
    const p = bezier(from, c1, c2, end, s);
    // Tremor fades as the hand settles on the target.
    const tremor = (1 - s) * 0.9;
    points.push({ point: { x: p.x + noise(rand, tremor), y: p.y + noise(rand, tremor) }, delay: step });
  }
  if (overshoot) {
    const back = Math.max(3, Math.round(between(rand, 4, 7)));
    for (let i = 1; i <= back; i++) {
      const s = minimumJerk(i / back);
      points.push({ point: { x: end.x + (to.x - end.x) * s, y: end.y + (to.y - end.y) * s }, delay: between(rand, 10, 18) });
    }
  }
  points.pop();
  return points.map(({ point, delay }) => ({ point: { x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 }, delay }));
}

/** Keep a pointer on screen: never negative, inside the viewport when known. */
export function clampPoint(p: Point, bounds?: { width: number; height: number }): Point {
  const clamp = (v: number, max: number | undefined) => Math.min(Math.max(v, 0), max === undefined ? Infinity : Math.max(0, max - 1));
  return { x: clamp(p.x, bounds?.width), y: clamp(p.y, bounds?.height) };
}

export const PRESS_MS: [number, number] = [60, 140];
export const SETTLE_MS: [number, number] = [45, 130];
export const KEY_GAP_MS: [number, number] = [30, 110];
/** Keys paced per burst (keys less than a second apart); the rest go out at
 *  socket speed. Bot scoring reads the first keystrokes of a field. */
export const KEY_PACED_BURST = 40;

interface TabState {
  pointer?: Point;
  aim?: Point & { dx: number; dy: number };
  arrivedAt: number;
  pressedAt?: number;
  lastKeyAt?: number;
  burst: number;
  queue: Promise<void>;
}

export interface HumanInputDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  rand?: Rand;
  enabled?: (tabKey: string | number) => boolean;
}

const PACED = new Set(["Input.dispatchMouseEvent", "Input.dispatchKeyEvent"]);

/**
 * One pacer, holding each tab's pointer and key clock. `beforeInput` runs
 * before an input command is forwarded: it sends the movement leading up to
 * it, waits out the press or key timing, and adjusts the command's own x/y in
 * place. Commands for one tab run in order, so a press waits for the movement
 * before it.
 */
export function createHumanInput(deps: HumanInputDeps = {}) {
  const sleep = deps.sleep ?? ((ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve()));
  const now = deps.now ?? Date.now;
  const rand = deps.rand ?? Math.random;
  const enabled = deps.enabled ?? ((tabKey: string | number) => humanInputEnabled(tabKey));
  const tabs = new Map<string | number, TabState>();
  const state = (key: string | number): TabState => {
    let t = tabs.get(key);
    if (!t) tabs.set(key, (t = { arrivedAt: 0, burst: 0, queue: Promise.resolve() }));
    return t;
  };

  /** Send one sample and wait until the next is due: for the sample to land,
   *  never past its gap (Chrome can hold a background tab's input reply for
   *  a frame, which would turn a 30-sample move into a 30-second one). */
  const pace = async (gap: number, sample: () => Promise<unknown>) => {
    const sent = now();
    await Promise.race([sample().catch(() => undefined), sleep(gap)]);
    await sleep(gap - (now() - sent));
  };

  const viewport = async (send: Send) => {
    const m = (await send("Page.getLayoutMetrics", {}).catch(() => undefined)) as
      | { cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }
      | undefined;
    const w = m?.cssLayoutViewport?.clientWidth;
    const h = m?.cssLayoutViewport?.clientHeight;
    return typeof w === "number" && typeof h === "number" && w > 0 && h > 0 ? { width: w, height: h } : undefined;
  };

  const travel = async (tab: TabState, to: Point, params: Record<string, unknown>, send: Send) => {
    // The first movement on a page starts somewhere plausible inside the viewport, not the corner.
    const bounds = tab.pointer ? undefined : await viewport(send);
    const from = clampPoint(tab.pointer ?? { x: to.x + between(rand, -260, 260), y: to.y + between(rand, -180, 180) }, bounds);
    for (const { point, delay } of trajectory(from, to, rand)) {
      const p = clampPoint(point, bounds);
      await pace(delay, () =>
        send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: p.x,
          y: p.y,
          ...(typeof params.buttons === "number" ? { buttons: params.buttons } : {}),
          ...(typeof params.modifiers === "number" ? { modifiers: params.modifiers } : {}),
        }),
      );
    }
    tab.arrivedAt = now();
  };

  const paceMouse = async (tab: TabState, params: Record<string, unknown>, send: Send) => {
    const type = params.type;
    if (typeof params.x !== "number" || typeof params.y !== "number" || type === "mouseWheel") return;
    // People land a few pixels off centre, the same way for the move, press and release on one target.
    if (!tab.aim || Math.hypot(tab.aim.x - params.x, tab.aim.y - params.y) >= 1) {
      tab.aim = { x: params.x, y: params.y, dx: noise(rand, 2.2), dy: noise(rand, 1.6) };
    }
    const x = Math.round((params.x + tab.aim.dx) * 10) / 10;
    const y = Math.round((params.y + tab.aim.dy) * 10) / 10;
    params.x = x;
    params.y = y;
    const far = !tab.pointer || Math.hypot(tab.pointer.x - x, tab.pointer.y - y) >= 2;
    if (type === "mouseMoved" || ((type === "mousePressed" || type === "mouseReleased") && far)) await travel(tab, { x, y }, params, send);
    if (type === "mousePressed") {
      await sleep(between(rand, ...SETTLE_MS) - (now() - tab.arrivedAt));
      tab.pressedAt = now();
    }
    if (type === "mouseReleased" && tab.pressedAt !== undefined) {
      await sleep(between(rand, ...PRESS_MS) - (now() - tab.pressedAt));
      tab.pressedAt = undefined;
    }
    tab.pointer = { x, y };
  };

  const paceKey = async (tab: TabState, params: Record<string, unknown>) => {
    if (params.type !== "keyDown" && params.type !== "rawKeyDown" && params.type !== "char") return;
    if (params.type === "char") return; // part of the keyDown before it
    const since = tab.lastKeyAt === undefined ? Infinity : now() - tab.lastKeyAt;
    tab.burst = since < 1000 ? tab.burst + 1 : 0;
    if (since < 1000 && tab.burst < KEY_PACED_BURST) await sleep(between(rand, ...KEY_GAP_MS) - since);
    tab.lastKeyAt = now();
  };

  return {
    beforeInput(tabKey: string | number, method: string, params: Record<string, unknown>, send: Send): Promise<void> {
      if (!PACED.has(method) || !params || !enabled(tabKey)) return Promise.resolve();
      const tab = state(tabKey);
      const run = tab.queue.then(() => (method === "Input.dispatchKeyEvent" ? paceKey(tab, params) : paceMouse(tab, params, send)));
      tab.queue = run.catch(() => undefined);
      return run;
    },
    forget(tabKey: string | number): void {
      tabs.delete(tabKey);
    },
  };
}

/** The process-wide pacer: the bridge host's relay and the built-in driver share it. */
export const humanInput = createHumanInput();
