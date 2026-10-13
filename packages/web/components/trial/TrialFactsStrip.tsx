"use client";
// The structured facts beside a trial decision's page: what the line checked
// and measured (checks, proof, diff, reach, evals owed, live evidence, cost),
// read from the card the run's code built, never written by the session. One
// short row each, so the page leads and the strip is a glance.
import Link from "next/link";
import type { TrialCardRow } from "../../hooks/useSyncTrial";
import { cn } from "../../lib/utils";
import { checkNotRun, honestChecks } from "@codecast/shared/contracts/changeCard";
import { overlapNote, ruleId, trialReach, workTime } from "../../lib/trialEvidence";

/** Longer than any build's working time: a card saying more counted a night at its gate. */
const WORK_DAY_MIN = 8 * 60;

type Fact = { label: string; value: string; tone?: "good" | "bad" | "warn"; title?: string; /** Where the fact can be read in full, when somewhere can show it. */ href?: string };

const TONE = { good: "text-sol-green", bad: "text-sol-red", warn: "text-sol-yellow" } as const;

/** The facts a card carries, in the order a reader checks them. */
export function trialFacts(c: TrialCardRow): Fact[] {
  const out: Fact[] = [];
  const card = c.card;
  // The run holds every check's and the proof's own output; the pull request holds the diff, once there is one.
  const runHref = c.run_id ? `/line?view=runs&run=${c.run_id}` : undefined;
  if (card) {
    // A check that never ran (the trial's unscored Eval) is neither green nor red: it counts as not run.
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
      title: [...checks.map((k) => `${checkNotRun(k) ? "not run" : k.ok ? "ok" : "red"} ${k.name}`), ...(owedEvals.length ? [`Evals owed: ${owedEvals.join(", ")}. The trial never runs them: they write to the database they point at.`] : [])].join("\n"),
    });
    const before = card.proof.before.filter((k) => !k.ok).length;
    const after = card.proof.after.filter((k) => !k.ok).length;
    if (card.proof.before.length || card.proof.after.length) out.push({ label: "Proof", value: `${before} red → ${after} red`, tone: before > 0 && after === 0 ? "good" : "warn", href: runHref });
    out.push({ label: "Diff", value: `${card.diff.files} files +${card.diff.added} −${card.diff.removed}`, href: card.diff.pr || undefined });
    // One count for the card (trialReach): covered of the problem's conversations now, with what it held when asked if that moved.
    const reach = trialReach(c);
    if (reach) out.push({ label: "Reaches", value: `${reach.covered} of ${reach.of}${reach.was !== undefined ? ` · was ${reach.was}` : ""}`, tone: reach.covered * 2 >= reach.of && reach.of > 0 ? undefined : reach.covered === 0 ? "bad" : "warn", title: `Conversations this change covers, of the problem's conversations now${reach.was !== undefined ? `. The problem held ${reach.was} when the card was asked` : ""}` });
    if (card.stops) out.push({ label: "Stops", value: `~${card.stops.per_week} ${card.stops.what}/wk`, title: card.stops.basis });
    out.push({ label: "Risk", value: card.risk.class, tone: card.risk.class === "low" ? undefined : "warn", title: card.risk.reason });
    // The evals a change owes are its Eval check, not run: said once, on the Checks row. A card with no such check says them here.
    if (owedEvals.length && !idle.length) out.push({ label: "Evals", value: `${owedEvals.length} not run`, tone: "warn", title: `Owed: ${owedEvals.join(", ")}. The trial never runs them: they write to the database they point at.` });
    // Minutes its stations worked; a card built before those were counted carries its run's wall clock, which says nothing.
    const worked = card.cost.minutes <= WORK_DAY_MIN ? `${workTime(card.cost.minutes)} · ` : "";
    out.push({ label: worked ? "Built in" : "Cost", value: `${worked}$${card.cost.usd.toFixed(2)}`, title: "Working time of the run's stations and what their sessions cost" });
  }
  const p = c.proposal;
  if (p) {
    if (p.measured) out.push({ label: "Measured", value: `${p.measured.count} of ${p.measured.of}`, tone: c.regrouped ? "bad" : undefined, title: `${p.measured.window} (${p.measured.method})${c.regrouped ? ". Taken before findings joined the problem: it counts another set" : ""}` });
    if (p.proof) out.push({ label: "Proof", value: `${p.proof.rung} · ${p.proof.outcome}` });
    if (p.risk) out.push({ label: "Risk", value: p.risk.class, tone: p.risk.class === "low" ? undefined : "warn", title: p.risk.reason });
  }
  const f = c.judge_fix;
  if (f) {
    out.push({ label: "Ruled cases", value: `${f.ab.ruled.base} → ${f.ab.ruled.arm} of ${f.ab.ruled.runs}`, tone: f.ab.ruled.arm < f.ab.ruled.base ? "good" : "bad" });
    out.push({ label: "Kept findings", value: `${f.ab.controls.base} → ${f.ab.controls.arm} of ${f.ab.controls.runs}`, tone: f.ab.controls.arm < f.ab.controls.base ? "warn" : undefined, title: `${f.ab.controls.moments} moments` });
    out.push({ label: "Verdict", value: f.ab.verdict.replace(/_/g, " "), tone: f.ab.verdict === "better" ? "good" : "warn" });
    out.push({ label: "Measured for", value: `$${f.ab.cost_usd.toFixed(2)}` });
  }
  // A change card's Reaches row already says the conversations; any other card says them here.
  if (c.evidence) out.push({ label: "Live now", value: card?.reach ? `${c.evidence.findings} ${c.evidence.findings === 1 ? "finding" : "findings"}` : `${c.evidence.findings} findings · ${c.evidence.conversations} conversations`, tone: c.evidence.findings ? undefined : "bad" });
  return out;
}

export function TrialFactsStrip({ card: c }: { card: TrialCardRow }) {
  const facts = trialFacts(c);
  return (
    <dl className="flex flex-col gap-2 text-[12px]" data-trial-facts>
      {facts.map((f) => (
        <div key={f.label} className="flex items-baseline justify-between gap-3" title={f.title}>
          <dt className="text-[11px] text-sol-text-dim">{f.label}</dt>
          <dd className={cn("text-right font-mono tabular-nums", f.tone ? TONE[f.tone] : "text-sol-text")}>
            {f.href ? <a href={f.href} target={f.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="underline decoration-dotted underline-offset-2 hover:decoration-solid" data-trial-fact-link={f.label}>{f.value}</a> : f.value}
          </dd>
        </div>
      ))}
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
