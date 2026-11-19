// What a climb says about itself: the status every agent station reads
// (`cast climb status`), and the summary the climb leaves on its goal and task
// at the end (candidates tried, what separated, what overfit, guard
// refusals, cost against the budget, and how it ended).
import type { Cand, ClimbState, Cut } from "./engine.js";
import { sign } from "./engine.js";
import { hypothesisVerdict } from "@codecast/shared/contracts/climb";

/** What the climb has filed so far, in one line: what a failed station still leaves on the record. */
export function filedLine(s: ClimbState | null): string {
  if (!s) return "Filed nothing: the climb had not started";
  const done = Object.entries(s.ledger.done).filter(([, d]) => !d.reused);
  const failed = Object.entries(s.ledger.failed ?? {});
  const usd = [...done.map(([, d]) => d.usd ?? 0), ...failed.map(([, f]) => f.usd)].reduce((a, b) => a + b, 0);
  if (!done.length && !failed.length) return "Filed nothing: no env run had started";
  const ids = done.map(([, d]) => d.attempt);
  const fails = failed.slice(0, 3).map(([k, f]) => `${k}: ${f.why.slice(0, 120)}`).join("; ");
  return `Filed ${done.length} run${done.length === 1 ? "" : "s"}${ids.length ? ` (${ids.slice(0, 8).join(", ")}${ids.length > 8 ? ", ..." : ""})` : ""}${failed.length ? `, ${failed.length} failed or unfiled (${fails})` : ""}; $${usd.toFixed(2)} spent`;
}

/** What production can read of one change, in one line: the card says it before the climb spends. */
export function readabilityLine(s: ClimbState): string | null {
  const r = s.readability;
  if (!r) return s.card.metric ? `Production read: not sized (the card names no production_lift for ${s.card.metric})` : null;
  if ("unread" in r) return `Production read: ${r.metric} cannot be sized: ${r.unread}`;
  const lift = `+${(r.lift * 100).toFixed(0)}%`;
  return r.readable
    ? `Production read: one change of ${lift} on ${r.metric} at ${r.level} is readable in a ${r.weeks}-week holdout`
    : `Production read: production cannot confirm one change of ${lift} on ${r.metric} at ${r.level}. The evidence is ${r.evidence}`;
}

const usd = (x: number) => `$${x.toFixed(2)}`;
const cutText = (env: string, k: Cut) => `${env} ${sign(k.delta)}${k.ci95 ? ` [${sign(k.ci95[0])}, ${sign(k.ci95[1])}]` : ""}${k.changed !== undefined ? `, ${k.changed} of ${k.of} cases moved` : ""}${k.attempt ? ` ${k.attempt}` : ""}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The level whose plausible effect the card staked the climb on: the highest scoring level kept that states one. */
function stakeLevel(s: ClimbState) {
  return s.levels.filter((l) => l.kept && l.level !== "L0" && l.plausible_effect).sort((a, b) => b.level.localeCompare(a.level))[0];
}

/**
 * What the climb found against what the card expected: the best candidate
 * that separated on dev, its effect on the staked level (held when it ran
 * there, else dev), and how many cases it moved. Null before Screen.
 */
export function observedEffect(s: ClimbState): { env: string; plausible: number; observed: number | null; cand?: Cand; cut?: Cut } | null {
  const l = stakeLevel(s);
  if (!l || !s.candidates.some((c) => c.dev[l.env])) return null;
  let best: { c: Cand; k: Cut; d: number } | null = null;
  for (const c of s.candidates) {
    const dev = c.dev[l.env];
    if (!dev?.keep) continue;
    // A held result read off the held runs' drift (Confirm flags it) says nothing about the change: read dev instead.
    const h = c.held[l.env];
    const k = h && !h.why.includes("the held runs drift") ? h : dev;
    if (!best || k.delta > best.d) best = { c, k, d: k.delta };
  }
  return { env: l.env, plausible: l.plausible_effect!, observed: best ? best.d : null, ...(best ? { cand: best.c, cut: best.k } : {}) };
}

/** The line the next Frame starts from: whether the card's expectation held, was weaker than expected, or was refuted. */
export function hypothesisLine(s: ClimbState): string | null {
  const e = observedEffect(s);
  if (!e) return null;
  const verdict = hypothesisVerdict(e.observed, e.plausible);
  const word = verdict === "held" ? "held" : verdict === "weaker" ? "weaker than expected" : "refuted";
  const target = s.card.target.split(/(?<=\.)\s/)[0];
  if (e.observed === null || !e.cand) return `Hypothesis: ${word}. No candidate separated from base on ${e.env} against the card's plausible ${sign(e.plausible)}. The card's target was: ${target}`;
  const moved = e.cut?.changed !== undefined ? `, moving ${e.cut.changed} of ${e.cut.of} cases` : "";
  return `Hypothesis: ${word}. The best survivor (${e.cand.id}) moved ${e.env} by ${sign(e.observed)} against the card's plausible ${sign(e.plausible)} (${pct(e.observed / e.plausible)})${moved}. The card's target was: ${target}`;
}

/** Each screened candidate's observed effect beside the card's plausible one, and how many cases it moved. */
export function effectLine(s: ClimbState): string | null {
  const e = observedEffect(s);
  if (!e) return null;
  const each = s.candidates.filter((c) => c.dev[e.env]).map((c) => { const k = c.dev[e.env]; return `${c.id} ${sign(k.delta)} (${pct(k.delta / e.plausible)})${k.changed !== undefined ? `, ${k.changed} of ${k.of} cases moved` : ""}`; });
  return `Effect against the card: plausible ${sign(e.plausible)} on ${e.env}; ${each.join("; ")}`;
}

function candLine(c: Cand): string[] {
  const out = [`${c.id} ${c.status}${c.branch ? ` ${c.branch}` : ""}${c.sha ? `@${c.sha.slice(0, 8)}` : ""}${c.predicted_delta !== undefined ? ` predicted ${sign(c.predicted_delta)}` : ""}`];
  if (c.hypothesis) out.push(`  hypothesis: ${c.hypothesis}`);
  const dev = Object.entries(c.dev).map(([e, k]) => cutText(e, k));
  if (dev.length) out.push(`  dev: ${dev.join("; ")}`);
  const held = Object.entries(c.held).map(([e, k]) => cutText(e, k));
  if (held.length) out.push(`  held: ${held.join("; ")}`);
  if (c.guard) out.push(`  guard: ${c.guard.pass ? "pass" : c.guard.why.startsWith("void") ? "pending" : "fail"}, ${c.guard.why}`);
  if (c.why) out.push(`  why: ${c.why}`);
  return out;
}

/** The whole state as plain lines, for the stations that read it. */
export function statusText(s: ClimbState): string {
  const b = s.card.budget;
  const lines = [
    `Climb on ${s.card.goal}${s.card.metric ? `:${s.card.metric}` : ""} from base ${s.base.slice(0, 12)}`,
    `Target: ${s.card.target}`,
    ...(readabilityLine(s) ? [readabilityLine(s)!] : []),
    `Budget: ${usd(s.ledger.usd)} of ${usd(b.usd)}, ${s.ledger.runs} of ${b.runs} runs; up to ${s.card.candidates} candidates${s.notes.length ? ` (${s.notes.join("; ")})` : ""}`,
    "",
    "Levels:",
    ...s.levels.map((l) => `  ${l.level} ${l.env} ${l.kept ? "kept" : "refused"}${l.held ? ", has held" : ""}${l.cost_usd ? `, ~${usd(l.cost_usd)} a run` : ""}: ${l.why}${l.held_aa ? `; held A/A: the base's two held runs moved ${l.held_aa.moved} of ${l.held_aa.of} cases (se ${l.held_aa.se.toFixed(4)})` : ""}`),
  ];
  if (s.card.hypotheses.length) lines.push("", "Hypothesis space:", ...s.card.hypotheses.map((h) => `  - ${h}`));
  if (s.candidates.length) lines.push("", "Candidates:", ...s.candidates.flatMap(candLine));
  const e = effectLine(s);
  if (e) lines.push("", e);
  const h = hypothesisLine(s);
  if (h) lines.push(h);
  const top = s.candidates.find((c) => c.status === "promoted");
  if (top) lines.push("", `Promoted: ${top.id} (${top.branch})`);
  if (s.pending) lines.push("", `Pending: ${s.pending}`);
  if (s.stopped) lines.push("", `Stopped: ${s.stopped}`);
  if (s.outcome) lines.push("", `Outcome: ${s.outcome}`);
  return lines.join("\n");
}

/** The record the climb leaves on its goal: short, one fact a line. */
export function summaryText(s: ClimbState): string {
  const by = (st: Cand["status"]) => s.candidates.filter((c) => c.status === st);
  const proposed = s.candidates.length;
  const admitted = s.candidates.filter((c) => c.status !== "refused").length;
  const scoring = new Set(s.levels.filter((l) => l.level !== "L0").map((l) => l.env));
  const separated = s.candidates.filter((c) => Object.entries(c.dev).some(([env, k]) => scoring.has(env) && k.keep));
  const top = by("promoted")[0];
  const lines = [
    `Climb on ${s.card.goal}${s.card.metric ? `:${s.card.metric}` : ""}${s.task ? ` (${s.task})` : ""}: ${top ? `${top.id} promoted${s.promoted_task ? ` as ${s.promoted_task}` : ""}${s.outcome ? `; ${s.outcome}` : ""}` : s.stopped ? `stopped, ${s.stopped}` : s.pending ? `held, ${s.pending}` : "unfinished"}.`,
    `Target: ${s.card.target}`,
    ...(readabilityLine(s) ? [readabilityLine(s)!] : []),
    `Levels: ${s.levels.map((l) => `${l.level} ${l.env} ${l.kept ? `kept (MDE ${l.noise?.mde.toFixed(3) ?? "0"})` : `refused (${l.why})`}`).join("; ")}.`,
    `Candidates: ${proposed} proposed, ${admitted} admitted, ${separated.length} separated from base on dev.`,
  ];
  for (const c of by("refused")) lines.push(`Refused ${c.id}: ${c.why}`);
  for (const c of by("overfit")) lines.push(`Overfit ${c.id} (${c.hypothesis.slice(0, 120)}): ${c.why}`);
  for (const c of by("guard_failed")) lines.push(`Guard refused ${c.id}: ${c.guard?.why ?? c.why}`);
  for (const c of by("unscreened")) lines.push(`Undecided ${c.id}: ${c.why}`);
  if (top) lines.push(`Promoted ${top.id} (${top.branch}): ${top.hypothesis.slice(0, 200)}; dev ${Object.entries(top.dev).map(([e, k]) => cutText(e, k)).join("; ")}; held ${Object.entries(top.held).map(([e, k]) => cutText(e, k)).join("; ")}.`);
  const h = hypothesisLine(s);
  if (h) lines.push(h);
  lines.push(`Cost: ${usd(s.ledger.usd)} of ${usd(s.card.budget.usd)}, ${s.ledger.runs} of ${s.card.budget.runs} runs.`);
  if (s.outcome && !top) lines.push(`Outcome: ${s.outcome}`);
  return lines.join("\n");
}
