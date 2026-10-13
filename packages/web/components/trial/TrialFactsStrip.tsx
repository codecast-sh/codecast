"use client";
// The structured facts beside a trial decision's page: what the line checked
// and measured (checks, proof, diff, reach, evals owed, live evidence, cost),
// read from the card the run's code built, never written by the session. One
// short row each, so the page leads and the strip is a glance.
import Link from "next/link";
import { useState } from "react";
import { TrialFactOpen } from "../line/widgets/TrialFactOpen";
import type { TrialCardRow } from "../../hooks/useSyncTrial";
import { cn } from "../../lib/utils";
import { checkNotRun, honestChecks } from "@codecast/shared/contracts/changeCard";
import { overlapNote, ruleId, trialReach, workTime } from "../../lib/trialEvidence";

/** Longer than any build's working time: a card saying more counted a night at its gate. */
const WORK_DAY_MIN = 8 * 60;

/** What a fact counts, opened in place (TrialFactOpen): the proof's own runs, the check list, the conversations reached, the branch diff. */
export type FactOpen = "proof" | "checks" | "reach" | "diff";

/** One measured fact of a card. `sub` is what it means in a few words, where a chip has room to say it. */
export type Fact = { label: string; value: string; sub?: string; tone?: "good" | "bad" | "warn"; title?: string; /** Where the fact can be read in full, when somewhere can show it. */ href?: string; /** The thing it counts, shown in place when pressed. */ opens?: FactOpen };

const TONE = { good: "text-sol-green", bad: "text-sol-red", warn: "text-sol-yellow" } as const;
const RISK_WORD: Record<string, string> = { low: "low", review: "needs review", plan: "needs a plan" };

/** "20 pass / 0 fail" out of a test run's tail, as passed of total; null when the detail does not say. */
export function passCount(detail: string | undefined): { pass: number; of: number } | null {
  const pass = /(\d+) pass\b/.exec(detail ?? "");
  const fail = /(\d+) fail\b/.exec(detail ?? "");
  if (!pass || !fail) return null;
  const p = Number(pass[1]);
  return { pass: p, of: p + Number(fail[1]) };
}

/**
 * The facts a card carries, in the order a reader checks them: did the fix work (proof), is it safe (checks), how
 * much of the problem it reaches, what it touches and costs. The one reading of a card's figures: /trial's strip and
 * LineDecision's chips (TrialEvidenceBand) both render these rows, so one card never says two things.
 */
/** A problem's page, at its findings; `finding` opens one of them. */
export const problemFindingsHref = (taskId: string, finding?: string): string =>
  `/line?view=problems&case=${encodeURIComponent(taskId)}${finding ? `&finding=${encodeURIComponent(finding)}` : ""}`;

export function trialFacts(c: TrialCardRow): Fact[] {
  const out: Fact[] = [];
  const card = c.card;
  // The run holds every check's and the proof's own output; the pull request holds the diff, once there is one.
  const runHref = c.run_id ? `/line?view=runs&run=${c.run_id}` : undefined;
  if (card) {
    // The proof test's own pass counts when its output says them, else how many proof cases failed before and after.
    const was = passCount(card.proof.before[0]?.detail);
    const now = passCount(card.proof.after[0]?.detail);
    if (was && now) out.push({ label: "Repro", value: `${was.pass}/${was.of} → ${now.pass}/${now.of}`, sub: "passing, before → after", tone: now.pass === now.of && was.pass < was.of ? "good" : "warn", href: runHref, opens: "proof", title: `${card.proof.before[0].name}: ${was.pass} of ${was.of} passed before the change, ${now.pass} of ${now.of} after` });
    else if (card.proof.before.length || card.proof.after.length) {
      const before = card.proof.before.filter((k) => !k.ok).length;
      const after = card.proof.after.filter((k) => !k.ok).length;
      out.push({ label: "Failing cases", value: `${before} → ${after}`, sub: "before → after", tone: before > 0 && after === 0 ? "good" : "warn", href: runHref, opens: "proof", title: `${before} failing before the change, ${after} after` });
    }
    // A check that never ran (the trial's unscored Eval) is neither green nor red: it counts as not run, and the evals
    // a change owes are that check, said once here.
    const owedEvals = c.evals_owed ?? [];
    const checks = honestChecks(card.checks);
    const idle = checks.filter(checkNotRun);
    const red = checks.filter((k) => !k.ok && !checkNotRun(k));
    const green = checks.length - idle.length - red.length;
    out.push({
      label: "Checks",
      value: [red.length ? `${red.length} red` : "", `${green} green`, idle.length ? `${idle.length} not run` : ""].filter(Boolean).join(" · "),
      tone: red.length ? "bad" : idle.length ? "warn" : "good",
      href: runHref,
      opens: "checks",
      title: [...checks.map((k) => `${checkNotRun(k) ? "not run" : k.ok ? "ok" : "red"} ${k.name}`), ...(owedEvals.length ? [`Evals owed: ${owedEvals.join(", ")}. The trial never runs them: they write to the database they point at.`] : [])].join("\n"),
    });
    // One count for the card (trialReach): covered of the problem's conversations now, with what it held when asked if that moved.
    const reach = trialReach(c);
    if (reach) out.push({ label: "Reaches", value: `${reach.covered} of ${reach.of}`, sub: reach.was !== undefined ? `conversations now · ${reach.was} when asked` : "conversations", tone: reach.covered * 2 >= reach.of && reach.of > 0 ? undefined : reach.covered === 0 ? "bad" : "warn", title: `Conversations this change covers, of the problem's conversations now${reach.was !== undefined ? `. The problem held ${reach.was} when the card was asked` : ""}` });
    out.push({ label: "Risk", value: RISK_WORD[card.risk.class] ?? card.risk.class, sub: card.risk.reason || undefined, tone: card.risk.class === "low" ? undefined : "warn", title: card.risk.reason });
    out.push({ label: "Diff", value: `${card.diff.files} files +${card.diff.added} −${card.diff.removed}`, href: card.diff.pr || undefined, opens: c.branch ? "diff" : undefined });
    if (card.stops) out.push({ label: "Stops", value: `~${card.stops.per_week} ${card.stops.what}/wk`, title: card.stops.basis });
    // A card with no unrun check still owes its evals: said here.
    if (owedEvals.length && !idle.length) out.push({ label: "Evals", value: `${owedEvals.length} not run`, tone: "warn", opens: "checks", title: `Owed: ${owedEvals.join(", ")}. The trial never runs them: they write to the database they point at.` });
    // Minutes its stations worked; a card built before those were counted carries its run's wall clock, which says nothing.
    const worked = card.cost.minutes <= WORK_DAY_MIN ? `${workTime(card.cost.minutes)} · ` : "";
    out.push({ label: worked ? "Built in" : "Cost", value: `${worked}$${card.cost.usd.toFixed(2)}`, title: "Working time of the run's stations and what their sessions cost" });
  }
  const p = c.proposal;
  if (p) {
    if (p.measured) out.push({ label: "Seen in", value: `${p.measured.count} of ${p.measured.of}`, sub: p.measured.window, tone: c.regrouped ? "bad" : undefined, title: `${p.measured.method === "replay" ? "Counted by replaying real cases on main" : "Counted in the product's own records"}${c.regrouped ? ". Taken before findings joined the problem: it counts another set" : ""}` });
    if (p.proof) out.push(p.proof.outcome === "red"
      ? { label: "Still broken on main", value: "yes", sub: `${p.proof.rung} check`, title: "The run's check showed the miss on main" }
      : { label: "Still broken on main", value: "not shown", sub: p.proof.outcome, tone: "warn", title: "No check could show the miss on main" });
    if (p.risk) out.push({ label: "Risk", value: RISK_WORD[p.risk.class] ?? p.risk.class, sub: p.risk.reason || undefined, tone: p.risk.class === "low" ? undefined : "warn", title: p.risk.reason });
  }
  const f = c.judge_fix;
  if (f) {
    out.push({ label: "Ruled cases", value: `${f.ab.ruled.base} → ${f.ab.ruled.arm} of ${f.ab.ruled.runs}`, tone: f.ab.ruled.arm < f.ab.ruled.base ? "good" : "bad" });
    out.push({ label: "Kept findings", value: `${f.ab.controls.base} → ${f.ab.controls.arm} of ${f.ab.controls.runs}`, tone: f.ab.controls.arm < f.ab.controls.base ? "warn" : undefined, title: `${f.ab.controls.moments} moments` });
    out.push({ label: "Verdict", value: f.ab.verdict.replace(/_/g, " "), tone: f.ab.verdict === "better" ? "good" : "warn" });
    out.push({ label: "Measured for", value: `$${f.ab.cost_usd.toFixed(2)}` });
  }
  // A change card's Reaches row already says the conversations; any other card says them here.
  // The problem's findings are on its own page.
  if (c.evidence) out.push({ label: "Live now", href: problemFindingsHref(c.task_id), value: card?.reach ? `${c.evidence.findings} ${c.evidence.findings === 1 ? "finding" : "findings"}` : `${c.evidence.findings} findings · ${c.evidence.conversations} conversations`, tone: c.evidence.findings ? undefined : "bad" });
  return out;
}

export function TrialFactsStrip({ card: c }: { card: TrialCardRow }) {
  const facts = trialFacts(c);
  const [open, setOpen] = useState<FactOpen | null>(null);
  const link = "underline decoration-dotted underline-offset-2 hover:decoration-solid";
  return (
    <dl className="flex flex-col gap-2 text-[12px]" data-trial-facts>
      {facts.map((f) => (
        <div key={f.label} className="flex items-baseline justify-between gap-3" title={f.title}>
          <dt className="text-[11px] text-sol-text-dim">{f.label}</dt>
          <dd className={cn("text-right font-mono tabular-nums", f.tone ? TONE[f.tone] : "text-sol-text")}>
            {f.opens ? <button type="button" className={link} aria-expanded={open === f.opens} data-trial-fact={f.opens} onClick={() => setOpen((o) => (o === f.opens ? null : f.opens!))}>{f.value}</button>
              : f.href ? <a href={f.href} target={f.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className={link} data-trial-fact-link={f.label}>{f.value}</a> : f.value}
          </dd>
        </div>
      ))}
      {open && <TrialFactOpen card={c} open={open} />}
      {c.rule && (
        <div className="mt-1 border-t border-sol-border/30 pt-2" data-trial-rule>
          <dt className="text-[11px] text-sol-text-dim">Rule</dt>
          <dd className="mt-0.5 text-sol-text-muted"><code className="font-mono text-sol-text">{ruleId(c.rule.id)}</code> {c.rule.text}</dd>
        </div>
      )}
      {(c.overlaps ?? []).length > 0 && (
        <div className="border-t border-sol-border/30 pt-2" data-trial-overlaps>
          <dt className="text-[11px] text-sol-text-dim">Same code as</dt>
          <dd className="mt-0.5 flex flex-col gap-1">
            {c.overlaps!.map((o) => {
              const note = overlapNote({ ...o, how: c.proposal?.alongside?.find((a) => a.card === o.card)?.line });
              // A line that concludes the two cannot conflict is a quiet chip, its reasoning a hover away.
              return note.clear ? (
                <Link key={o.card} href={`/trial?card=${o.card}`} className="w-fit rounded border border-sol-border/40 px-1.5 py-0.5 text-[11px] text-sol-text-dim hover:text-sol-text" title={note.text} data-trial-overlap="clear">no conflict with {o.card}</Link>
              ) : (
                <Link key={o.card} href={`/trial?card=${o.card}`} className="text-sol-yellow hover:underline" title={o.title} data-trial-overlap="open"><span className="font-mono">{o.card}</span> <span className="text-sol-text-muted">{note.text}</span></Link>
              );
            })}
          </dd>
        </div>
      )}
    </dl>
  );
}
