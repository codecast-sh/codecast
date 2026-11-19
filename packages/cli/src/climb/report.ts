// What a climb says about itself: the status every agent station reads
// (`cast climb status`), and the summary the climb leaves on its goal and task
// at the end (candidates tried, what separated, what overfit, guard
// refusals, cost against the budget, and how it ended).
import type { Cand, ClimbState, Cut } from "./engine.js";
import { sign } from "./engine.js";

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
const cutText = (env: string, k: Cut) => `${env} ${sign(k.delta)}${k.ci95 ? ` [${sign(k.ci95[0])}, ${sign(k.ci95[1])}]` : ""}${k.attempt ? ` ${k.attempt}` : ""}`;

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
    ...s.levels.map((l) => `  ${l.level} ${l.env} ${l.kept ? "kept" : "refused"}${l.held ? ", has held" : ""}${l.cost_usd ? `, ~${usd(l.cost_usd)} a run` : ""}: ${l.why}`),
  ];
  if (s.card.hypotheses.length) lines.push("", "Hypothesis space:", ...s.card.hypotheses.map((h) => `  - ${h}`));
  if (s.candidates.length) lines.push("", "Candidates:", ...s.candidates.flatMap(candLine));
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
  lines.push(`Cost: ${usd(s.ledger.usd)} of ${usd(s.card.budget.usd)}, ${s.ledger.runs} of ${s.card.budget.runs} runs.`);
  if (s.outcome && !top) lines.push(`Outcome: ${s.outcome}`);
  return lines.join("\n");
}
