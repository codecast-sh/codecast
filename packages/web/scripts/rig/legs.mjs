// The legs: each one drives a real flow between the two browsers through
// the header row's own buttons, records both rows, and asserts the seams.
//
// A leg returns its timings (ms from the press that started it), the state
// sequence per face on each side, the seam verdict (no face reads engaged,
// then presence, then engaged again), and the identity verdict (no face node
// remounted). Screenshots of both bars land in the run directory at every
// named state.
import { killChrome, launchChrome } from "./chrome.mjs";
import { connect, sleep } from "./cdp.mjs";
import { IDENTITIES, signIn } from "./auth.mjs";
import { ENGAGED, offThenOn, PAGE_LIB } from "./page.mjs";

const RILEY = IDENTITIES.riley.id;
const JORDAN = IDENTITIES.jordan.id;

/** A side whose browser is up. A SIGKILL sets `gone` at once: the child's
 *  exit code lands a tick later, and a page asked in between answers nothing. */
export const alive = (side) => !side.gone && side.child?.exitCode === null;

/** Kill a side's browser and mark it gone. */
export function killSide(side) {
  side.gone = true;
  killChrome(side.child, side.profile);
}

/** Give the runner a browser, a page and the recorder for one identity. */
export async function bringUp(who, { fresh = true, dir, attach = false }) {
  const id = IDENTITIES[who];
  const side = { who, id: id.id, other: who === "riley" ? JORDAN : RILEY, child: null, page: null, port: id.port, profile: `${dir}/prof-${who}`, gone: false };
  // A browser a previous run left up (--keep) is reused as it is.
  if (attach && (await fetch(`http://127.0.0.1:${id.port}/json/version`).then((r) => r.ok, () => false))) {
    side.page = await connect(id.port);
    side.child = { exitCode: null, kill: () => {} };
    await side.page.evaluate(PAGE_LIB);
    return side;
  }
  side.child = await launchChrome({ port: id.port, profile: side.profile, fresh });
  side.page = await connect(id.port, /about:blank|localhost/);
  await side.page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await signIn(side.page, who);
  await side.page.evaluate(PAGE_LIB);
  return side;
}

/** Both rows show the other person online, so a leg starts from presence. */
export async function waitPresent(side, timeoutMs = 60_000) {
  return side.page.evaluate(
    `__rig.waitFor(${JSON.stringify(`s.entries.some(e => e.id === "${side.other}" && e.state === "online") && s.card === "none"`)}, ${timeoutMs})`,
  );
}

/** Hand every seat back on both sides, whatever the leg left. Cleanup, not
 *  the flow under test, so it may reach the engine directly. */
export async function settle(sides) {
  for (const s of sides) {
    if (!alive(s)) continue;
    try {
      await s.page.evaluate(`(async () => { await window.__walkie?.end(); await window.__callManager?.leaveCall(); return "settled"; })()`);
    } catch {
      // a page mid navigation answers nothing; the next waitPresent tells the truth
    }
  }
  await sleep(300);
}

export class Leg {
  constructor(name, sides, { dir, log }) {
    this.name = name;
    this.sides = sides;
    this.dir = dir;
    this.print = log ?? console.log;
    this.t0 = 0;
    this.timings = [];
    this.shots = [];
  }
  async start() {
    this.t0 = Date.now();
    for (const s of this.sides) await s.page.evaluate(`__rig.start(${JSON.stringify(this.name)}, ${this.t0})`);
    this.print(`\n== ${this.name} ==`);
  }
  since() {
    return Date.now() - this.t0;
  }
  /** Record a named moment, in ms since the leg's press. */
  stamp(name, t = this.since()) {
    this.timings.push({ name, ms: t });
    this.print(`  ${String(t).padStart(6)} ms  ${name}`);
    return t;
  }
  /** Wait on one side for a condition over (snap, model, call), then stamp it. */
  async until(side, name, cond, timeoutMs = 15_000) {
    await side.page.evaluate(`__rig.waitFor(${JSON.stringify(cond)}, ${timeoutMs})`);
    return this.stamp(`${name} [${side.who}]`);
  }
  async both(name, cond, timeoutMs) {
    for (const s of this.sides) await this.until(s, name, cond, timeoutMs);
  }
  async shot(tag) {
    for (const s of this.sides) {
      if (!alive(s)) continue;
      const file = `${this.dir}/${this.name}-${tag}-${s.who}.png`;
      try {
        await s.page.screenshot(file, ".people-bar");
        this.shots.push({ tag, who: s.who, file });
      } catch (e) {
        this.print(`  (no shot ${tag} on ${s.who}: ${e.message})`);
      }
    }
  }
  /** Stop both recorders and judge the seams and the node identity. */
  async finish() {
    const result = { name: this.name, timings: this.timings, shots: this.shots, sides: {}, ok: true, problems: [] };
    for (const s of this.sides) {
      if (!alive(s)) continue;
      const rec = await s.page.evaluate(`__rig.stop ? __rig.stop() : null`);
      if (!rec) continue;
      const seam = offThenOn(rec.log, s.other);
      const mine = offThenOn(rec.log, s.id);
      const tagged = rec.identity.find((e) => e.id === s.other);
      const startTag = rec.log.find((e) => e.init) ? true : false;
      const remounted = !!tagged && tagged.tag === null && startTag;
      result.sides[s.who] = { other: seam.states, me: mine.states, log: rec.log, identity: rec.identity };
      const cardSeq = rec.log.filter((e) => e.card !== undefined).map((e) => e.card);
      result.sides[s.who].cards = cardSeq;
      this.print(`  ${s.who}: them ${seam.states.join(" > ")} | me ${mine.states.join(" > ") || "(absent)"} | card ${cardSeq.join(" > ") || "none"}`);
      for (const b of seam.bad) result.problems.push(`${s.who} saw ${s.other} read ${b}`);
      if (remounted) result.problems.push(`${s.who}: the face node for ${s.other} was remounted`);
    }
    if (result.problems.length) {
      result.ok = false;
      for (const p of result.problems) this.print(`  PROBLEM: ${p}`);
    }
    return result;
  }
}

const eng = (id) => `s.entries.some(e => e.id === "${id}" && (${[...ENGAGED].map((x) => `e.state === "${x}"`).join(" || ")}))`;
const state = (id, ...st) => `s.entries.some(e => e.id === "${id}" && (${st.map((x) => `e.state === "${x}"`).join(" || ")}))`;
const link = (id, ...k) => `s.entries.some(e => e.id === "${id}" && (${k.map((x) => `e.link === "${x}"`).join(" || ")}))`;
const me = (id) => `s.entries[0] && s.entries[0].id === "${id}" && s.entries[0].me`;
const card = (k) => `s.card === "${k}"`;
const noMe = `!s.entries.some(e => e.me)`;

/**
 * Walkie: press, the far side hears and joins live, key up stays live, End
 * returns both rows to presence.
 */
export async function walkieLeg(A, B, opts) {
  const leg = new Leg("walkie", [A, B], opts);
  await leg.shot("idle");
  await leg.start();
  await A.page.evaluate(`__rig.action("${B.id}", "talk")`);
  leg.stamp("press [riley]");
  await leg.until(A, "row shows me + them linked warm", `${me(A.id)} && ${state(B.id, "hearing-me", "live-with-me")} && ${link(B.id, "tx", "both")}`);
  await leg.shot("holding");
  await leg.until(B, "far side sees cool link + card", `${state(A.id, "talking-to-me")} && ${link(A.id, "rx", "both")} && ${card("incoming")}`, 20_000);
  await leg.shot("incoming");
  await B.page.evaluate(`__rig.card("join")`);
  leg.stamp("Join live pressed [jordan]");
  await leg.until(A, "both live (sender sees the join)", `${state(B.id, "live-with-me", "speaking", "joining")} && ${link(B.id, "call", "tx", "both")}`, 20_000);
  await leg.until(B, "both live (joiner)", `${me(B.id)} && ${state(A.id, "live-with-me", "speaking", "talking-to-me")} && (${card("live")} || ${card("joined-notice")})`, 20_000);
  await leg.shot("live");
  await A.page.evaluate(`__rig.action("${B.id}", "talk")`);
  leg.stamp("key up [riley]");
  await sleep(1500);
  await leg.until(A, "still live after key up", `${me(A.id)} && ${state(B.id, "live-with-me", "speaking")} && ${link(B.id, "call")} && (${card("live")} || ${card("joined-notice")})`, 5_000);
  await leg.until(B, "still live after key up (far side)", `${me(B.id)} && ${state(A.id, "live-with-me", "speaking")}`, 5_000);
  await leg.shot("keyup");
  await A.page.evaluate(`__rig.card("end")`);
  leg.stamp("End pressed [riley]");
  await leg.until(A, "row back to presence", `${noMe} && ${state(B.id, "online", "idle", "in-call")} && ${card("none")}`, 20_000);
  await leg.until(B, "far side sees the end", `${state(A.id, "online", "idle")}`, 20_000);
  if (await B.page.evaluate(`__rig.snap().card !== "none"`)) {
    await B.page.evaluate(`__rig.card("end")`);
    leg.stamp("End pressed [jordan]");
    await leg.until(B, "far side row back to presence", `${noMe} && ${card("none")}`, 20_000);
  }
  await leg.shot("ended");
  return leg.finish();
}

/** Ring: ring out, ring in, answer, in call, leave. */
export async function ringLeg(A, B, opts) {
  const leg = new Leg("ring", [A, B], opts);
  await leg.start();
  await A.page.evaluate(`__rig.action("${B.id}", "ring")`);
  leg.stamp("Ring pressed [riley]");
  await leg.until(A, "ring out on the row", `${me(A.id)} && ${state(B.id, "ringing-them")} && ${link(B.id, "ring")} && ${card("ring-out")}`, 20_000);
  await leg.shot("ring-out");
  await leg.until(B, "ring in on the far row", `${state(A.id, "ringing-me")} && ${card("ring-in")}`, 20_000);
  await leg.shot("ring-in");
  await B.page.evaluate(`__rig.card("answer")`);
  leg.stamp("Answer pressed [jordan]");
  await leg.until(A, "in call (caller)", `${me(A.id)} && ${state(B.id, "live-with-me", "speaking")} && ${link(B.id, "call")} && (${card("live")} || ${card("joined-notice")})`, 25_000);
  await leg.until(B, "in call (callee)", `${me(B.id)} && ${state(A.id, "live-with-me", "speaking")} && ${link(A.id, "call")} && (${card("live")} || ${card("joined-notice")})`, 25_000);
  await leg.shot("in-call");
  await B.page.evaluate(`__rig.card("end")`);
  leg.stamp("Leave pressed [jordan]");
  await leg.until(B, "callee row back to presence", `${noMe} && ${card("none")}`, 20_000);
  await leg.until(A, "caller sees the leave", `${state(B.id, "online", "idle")}`, 20_000);
  await A.page.evaluate(`__rig.card("end")`);
  leg.stamp("Leave pressed [riley]");
  await leg.until(A, "caller row back to presence", `${noMe} && ${card("none")}`, 20_000);
  await leg.shot("ended");
  const result = await leg.finish();
  // The caller's first card is the ring out: never a live call with nobody
  // on it while the invite is on its way (an End that turns into a Cancel).
  const first = result.sides[A.who]?.cards?.[0];
  if (first && first !== "ring-out") {
    result.ok = false;
    result.problems.push(`${A.who}: the first card after Ring was ${first}, not ring-out`);
    leg.print(`  PROBLEM: ${result.problems.at(-1)}`);
  }
  return result;
}

/** A LiveKit reconnect under a live call keeps the call on the row. */
export async function reconnectLeg(A, B, opts) {
  const leg = new Leg("reconnect", [A, B], opts);
  await leg.start();
  await A.page.evaluate(`__rig.action("${B.id}", "ring")`);
  await leg.until(B, "ring in", `${card("ring-in")}`, 20_000);
  await B.page.evaluate(`__rig.card("answer")`);
  await leg.until(A, "in call", `${me(A.id)} && ${state(B.id, "live-with-me", "speaking")} && c && c.phase === "connected"`, 25_000);
  await A.page.evaluate(`__rig.livekit("reconnecting")`);
  leg.stamp("LiveKit Reconnecting emitted [riley]");
  await sleep(2000);
  await leg.until(A, "still in call through Reconnecting", `${me(A.id)} && ${state(B.id, "live-with-me", "speaking")} && ${link(B.id, "call")} && c && c.phase === "connected"`, 3_000);
  await leg.shot("reconnecting");
  await A.page.evaluate(`__rig.livekit("connected")`);
  leg.stamp("LiveKit Connected emitted [riley]");
  await sleep(1000);
  await leg.until(A, "still in call after Connected", `${me(A.id)} && ${state(B.id, "live-with-me", "speaking")} && c && c.phase === "connected"`, 3_000);
  await A.page.evaluate(`__rig.card("end")`);
  await leg.until(A, "caller row back to presence", `${noMe} && ${card("none")}`, 20_000);
  await leg.until(B, "callee sees the end", `${state(A.id, "online", "idle")}`, 20_000);
  if (await B.page.evaluate(`__rig.snap().card !== "none"`)) {
    await B.page.evaluate(`__rig.card("end")`);
    await leg.until(B, "callee row back to presence", `${noMe} && ${card("none")}`, 20_000);
  }
  return leg.finish();
}

/**
 * A dead seat: the far browser is killed mid call (no leave, no unload, no
 * last heartbeat) and the caller's row must drop the face. The lease is
 * CALL_MEMBER_STALE_MS (45s) and the living side's heartbeat sweeps every
 * CALL_HEARTBEAT_MS (15s), so the bound is 60s from the kill, and within 15s
 * of the lease lapsing. Both are reported. Jordan's browser is brought back
 * afterwards for the legs that follow.
 */
export async function deadSeatLeg(A, B, opts) {
  const leg = new Leg("dead-seat", [A, B], opts);
  await leg.start();
  await A.page.evaluate(`__rig.action("${B.id}", "ring")`);
  await leg.until(B, "ring in", `${card("ring-in")}`, 20_000);
  await B.page.evaluate(`__rig.card("answer")`);
  await leg.until(A, "in call", `${me(A.id)} && ${state(B.id, "live-with-me", "speaking")} && c && c.phase === "connected"`, 25_000);
  await leg.shot("in-call");
  const killedAt = Date.now();
  killSide(B);
  leg.stamp("far browser killed (SIGKILL)");
  await leg.until(A, "dead seat gone from the row", `!${eng(B.id)}`, 90_000);
  const gone = Date.now() - killedAt;
  leg.stamp(`kill -> face left the row: ${gone} ms (lease 45000 + beat 15000 bound, ${Math.max(0, gone - 45_000)} ms past the lease)`, gone);
  await leg.shot("dead-gone");
  await A.page.evaluate(`__rig.card("end")`).catch(() => {});
  await leg.until(A, "caller row back to presence", `${noMe} && ${card("none")}`, 20_000);
  const result = await leg.finish();
  result.deadSeat = { killToGoneMs: gone, pastLeaseMs: Math.max(0, gone - 45_000) };
  return result;
}
