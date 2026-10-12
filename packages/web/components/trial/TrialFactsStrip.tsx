"use client";
// The structured facts beside a trial decision's page: what the line checked
// and measured (checks, proof, diff, reach, evals owed, live evidence, cost),
// read from the card the run's code built, never written by the session. One
// short row each, so the page leads and the strip is a glance.
import Link from "next/link";
import type { TrialCardRow } from "../../hooks/useSyncTrial";
import { cn } from "../../lib/utils";
import { ruleId } from "../../lib/trialEvidence";

type Fact = { label: string; value: string; tone?: "good" | "bad" | "warn"; title?: string };

const TONE = { good: "text-sol-green", bad: "text-sol-red", warn: "text-sol-yellow" } as const;

/** The facts a card carries, in the order a reader checks them. */
export function trialFacts(c: TrialCardRow): Fact[] {
  const out: Fact[] = [];
  const card = c.card;
  if (card) {
    const red = card.checks.filter((k) => !k.ok);
    out.push({ label: "Checks", value: red.length ? `${red.length} red of ${card.checks.length}` : `${card.checks.length} green`, tone: red.length ? "bad" : "good", title: card.checks.map((k) => `${k.ok ? "ok" : "red"} ${k.name}`).join("\n") });
    const before = card.proof.before.filter((k) => !k.ok).length;
    const after = card.proof.after.filter((k) => !k.ok).length;
    if (card.proof.before.length || card.proof.after.length) out.push({ label: "Proof", value: `${before} red → ${after} red`, tone: before > 0 && after === 0 ? "good" : "warn" });
    out.push({ label: "Diff", value: `${card.diff.files} files +${card.diff.added} −${card.diff.removed}` });
    if (card.reach) out.push({ label: "Reaches", value: `${card.reach.conversations} of ${card.reach.of} conversations`, tone: card.reach.conversations * 2 >= card.reach.of ? undefined : "warn" });
    if (card.stops) out.push({ label: "Stops", value: `~${card.stops.per_week} ${card.stops.what}/wk`, title: card.stops.basis });
    out.push({ label: "Risk", value: card.risk.class, tone: card.risk.class === "low" ? undefined : "warn", title: card.risk.reason });
    const owed = c.evals_owed ?? [];
    if (owed.length) out.push({ label: "Evals owed", value: owed.join(", "), tone: "warn", title: "The trial never runs the eval suite" });
    out.push({ label: "Built in", value: `${card.cost.minutes} min · $${card.cost.usd.toFixed(2)}` });
  }
  const p = c.proposal;
  if (p) {
    if (p.measured) out.push({ label: "Measured", value: `${p.measured.count} of ${p.measured.of}`, title: `${p.measured.window} (${p.measured.method})` });
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
  if (c.evidence) out.push({ label: "Live now", value: `${c.evidence.findings} findings · ${c.evidence.conversations} conversations`, tone: c.evidence.findings ? undefined : "bad" });
  return out;
}

export function TrialFactsStrip({ card: c }: { card: TrialCardRow }) {
  const facts = trialFacts(c);
  return (
    <dl className="flex flex-col gap-2 text-[12px]" data-trial-facts>
      {facts.map((f) => (
        <div key={f.label} className="flex items-baseline justify-between gap-3" title={f.title}>
          <dt className="text-[11px] text-sol-text-dim">{f.label}</dt>
          <dd className={cn("text-right font-mono tabular-nums", f.tone ? TONE[f.tone] : "text-sol-text")}>{f.value}</dd>
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
          <dd className="mt-0.5 flex flex-col gap-0.5">
            {c.overlaps!.map((o) => <Link key={o.card} href={`/trial?card=${o.card}`} className="truncate text-sol-yellow hover:underline" title={`${o.title} · ${o.where}`}>{o.card} {o.title}</Link>)}
          </dd>
        </div>
      )}
    </dl>
  );
}
