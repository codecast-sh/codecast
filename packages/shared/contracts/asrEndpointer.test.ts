import { describe, expect, test } from "bun:test";

import { createEndpointer, type EndpointEvent } from "./asrEndpointer";

const RATE = 24_000;
const n = (ms: number) => Math.round((ms / 1000) * RATE);

/** Deterministic noise, so a failing run is the same run twice. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

const dbfs = (db: number) => 10 ** (db / 20);

/** Room noise at `db` dBFS RMS (uniform noise has RMS = amplitude / sqrt(3)). */
function noise(ms: number, db: number, rand = rng(7)): Int16Array {
  const out = new Int16Array(n(ms));
  const amp = dbfs(db) * Math.sqrt(3) * 2;
  for (let i = 0; i < out.length; i++) out[i] = Math.round(rand() * amp * 32767);
  return out;
}

/** Something shaped like speech: a 180 Hz voice under a 4 Hz syllable
 *  envelope, so it dips between syllables the way talking does. */
function speech(ms: number, db = -20, under?: Int16Array): Int16Array {
  const out = new Int16Array(n(ms));
  const amp = dbfs(db) * Math.SQRT2 * 1.6;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const env = Math.abs(Math.sin(2 * Math.PI * 4 * t));
    const v = amp * env * Math.sin(2 * Math.PI * 180 * t) + (under ? under[i % under.length]! / 32767 : 0);
    out[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
  }
  return out;
}

const silence = (ms: number) => new Int16Array(n(ms));

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Feed in uneven chunks (a ScriptProcessor buffer is not a frame). */
function run(pcm: Int16Array, chunk = 4_093): EndpointEvent[] {
  const ep = createEndpointer();
  const events: EndpointEvent[] = [];
  for (let i = 0; i < pcm.length; i += chunk) events.push(...ep.push(pcm.subarray(i, i + chunk)));
  return events;
}

const ms = (samples: number) => (samples / RATE) * 1000;

describe("asrEndpointer", () => {
  test("silence is never a turn", () => {
    expect(run(silence(5_000))).toEqual([]);
  });

  test("a sentence then a pause is one turn, stamped at the speech", () => {
    const events = run(concat(silence(1_000), speech(1_200), silence(800)));
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    const end = events[1] as Extract<EndpointEvent, { type: "end" }>;
    expect(end.forced).toBe(false);
    expect(ms(end.start)).toBeGreaterThanOrEqual(1_000);
    expect(ms(end.start)).toBeLessThan(1_060);
    expect(ms(end.end)).toBeGreaterThan(2_100);
    expect(ms(end.end)).toBeLessThanOrEqual(2_200);
  });

  test("the turn closes 600 ms after the speech, not before", () => {
    const ep = createEndpointer();
    ep.push(concat(silence(1_000), speech(1_000)));
    expect(ep.push(silence(500)).filter((e) => e.type === "end")).toEqual([]);
    expect(ep.speaking).toBe(true);
    expect(ep.push(silence(200)).map((e) => e.type)).toEqual(["end"]);
    expect(ep.speaking).toBe(false);
  });

  test("a click shorter than 250 ms of voice is not a turn", () => {
    expect(run(concat(silence(1_000), speech(120), silence(1_000)))).toEqual([]);
  });

  test("a breath inside a sentence does not split it", () => {
    const events = run(concat(silence(1_000), speech(1_000), silence(350), speech(1_000), silence(800)));
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
  });

  test("two sentences with a real pause are two turns", () => {
    const events = run(concat(silence(1_000), speech(1_000), silence(900), speech(1_000), silence(800)));
    expect(events.map((e) => e.type)).toEqual(["start", "end", "start", "end"]);
  });

  test("talking from the first sample is still heard", () => {
    const events = run(concat(speech(1_500), silence(800)));
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
    expect(ms((events[0] as { at: number }).at)).toBeLessThan(150);
  });

  test("a noisy room is not speech, and a voice over it is", () => {
    const room = noise(12_000, -38);
    expect(run(room)).toEqual([]);
    const events = run(concat(noise(3_000, -38), speech(1_500, -16, noise(1_500, -38, rng(3))), noise(1_500, -38, rng(9))));
    expect(events.map((e) => e.type)).toEqual(["start", "end"]);
  });

  test("a monologue with no pause is cut near 15 s and keeps going", () => {
    const events = run(concat(silence(1_000), speech(40_000), silence(800)));
    const ends = events.filter((e): e is Extract<EndpointEvent, { type: "end" }> => e.type === "end");
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    expect(ends.length).toBeGreaterThanOrEqual(2);
    for (const cut of ends.slice(0, -1)) {
      expect(cut.forced).toBe(true);
      const len = ms(cut.end - cut.start);
      expect(len).toBeGreaterThanOrEqual(15_000);
      expect(len).toBeLessThanOrEqual(20_000);
    }
    // Each cut picks up where the last left off: no audio falls between turns.
    for (let i = 1; i < ends.length; i++) expect(ends[i]!.start).toBe(ends[i - 1]!.end);
    expect(ends.at(-1)!.forced).toBe(false);
  });

  test("the forced cut lands on a dip between syllables", () => {
    const events = run(concat(silence(1_000), speech(17_000)));
    const cut = events.find((e) => e.type === "end") as Extract<EndpointEvent, { type: "end" }>;
    // The 4 Hz envelope is at zero every 125 ms; the cut frame sits within
    // a frame of one.
    const t = ms(cut.end) / 1000 - 1;
    const phase = (t * 8) % 1;
    expect(Math.min(phase, 1 - phase)).toBeLessThan(0.2);
  });

  test("chunk size does not change the answer", () => {
    const pcm = concat(silence(1_000), speech(1_200), silence(800), speech(700), silence(900));
    expect(run(pcm, 480)).toEqual(run(pcm, 4_096));
  });
});
