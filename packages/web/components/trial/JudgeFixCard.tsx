"use client";
// The judge route's card (shared/contracts/judgeFix.ts, learning-loop.md
// LL11): a fix to one of codecast's judges, its extractor or an expectation,
// measured on the moments its cases were ruled on. The reviewer reads, in
// this order: what changes, whether it worked (the ruled cases stop being
// found, the kept findings stay), the edited lines, and each case.
import type { ReactNode } from "react";
import { caseMoved, restEmptied, type JudgeFixCard, type JudgeFixCase, type JudgeFixGroup } from "@codecast/shared/contracts/judgeFix";
import { cn } from "../../lib/utils";
import { CardFacts, type CardFactsProps } from "../decisions/CardFacts";

const VERDICT: Record<JudgeFixCard["ab"]["verdict"], { label: string; tone: string }> = {
  better: { label: "Works", tone: "text-sol-green" },
  not_separated: { label: "Not shown to work", tone: "text-sol-yellow" },
  worse: { label: "Loses real findings", tone: "text-sol-red" },
  few_controls: { label: "Too few kept findings to tell", tone: "text-sol-yellow" },
  empties_proposal: { label: "Empties a waiting proposal", tone: "text-sol-red" },
};

/** Each judge or extractor the edit touches, by name; helper files ride with their extractor. */
function partsOf(card: JudgeFixCard): string[] {
  const names = card.diff.flatMap((d) => {
    const judge = /judges\/([\w-]+)\.md$/.exec(d.file);
    if (judge) return [`${judge[1]} judge`];
    const kind = /moments\/([\w-]+)\.ts$/.exec(d.file);
    return kind ? [`${kind[1]} extractor`] : [];
  });
  return names.length ? [...new Set(names)] : [card.part.name];
}

const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);

/** One group's before and after as two bars on one scale; `wants` is the direction that is good. */
function Shift({ label, group, wants }: { label: string; group: JudgeFixGroup; wants: "fewer" | "more" }) {
  const before = pct(group.base, group.runs);
  const after = pct(group.arm, group.runs);
  const good = wants === "fewer" ? after < before : after >= before;
  return (
    <div className="grid grid-cols-[7.5rem_1fr_4.5rem] items-center gap-x-3 gap-y-1 text-[12px]" data-judge-fix-group={wants}>
      <span className="row-span-2 text-sol-text-muted">{label}<span className="block text-[11px] text-sol-text-dim">{group.messages !== undefined ? `${group.messages} message${group.messages === 1 ? "" : "s"}` : `${group.moments} moments`}</span></span>
      <span className="relative h-2 rounded-full bg-sol-border/30"><span className="absolute inset-y-0 left-0 rounded-full bg-sol-text-dim/50" style={{ width: `${before}%` }} /></span>
      <span className="tabular-nums text-sol-text-dim">{group.base}/{group.runs}</span>
      <span className="relative h-2 rounded-full bg-sol-border/30"><span className={cn("absolute inset-y-0 left-0 rounded-full", good ? "bg-sol-green" : "bg-sol-red")} style={{ width: `${after}%` }} /></span>
      <span className={cn("tabular-nums", good ? "text-sol-green" : "text-sol-red")} title={group.p !== null ? `p = ${group.p.toFixed(4)}` : undefined}>{group.arm}/{group.runs}</span>
    </div>
  );
}

/** One judge run's cost, before and after, when the edit moves it by more than a twentieth. */
function perRun(card: JudgeFixCard): string | null {
  const u = card.ab.usd_per_run;
  if (!u || !u.base || Math.abs(u.arm - u.base) / u.base < 0.05) return null;
  const c = (n: number) => `${(n * 100).toFixed(1)}¢`;
  return `${c(u.base)} → ${c(u.arm)} a judge run`;
}

/** The ruled cases one group at a time: those the edit moves, then those it leaves as they were. One message is one row, however many moments show it. */
function CaseList({ title, cases, moved }: { title: string; cases: JudgeFixCase[]; moved?: boolean }) {
  if (!cases.length) return null;
  return (
    <section className="mt-6" data-judge-fix-cases={moved ? "moved" : "unmoved"}>
      <h2 className={cn("text-[11px] font-medium uppercase tracking-wide", moved ? "text-sol-green" : "text-sol-text-dim")}>{title} · {cases.length}</h2>
      <ul className="mt-1.5 divide-y divide-sol-border/30 border-y border-sol-border/30">
        {cases.map((c) => (
          <li key={`${c.finding}-${c.expectation}`} className="grid grid-cols-[1fr_auto] gap-x-4 py-2.5 text-[12px]">
            <span className="min-w-0">
              <span className={cn("block text-sol-text-muted", moved && "line-through decoration-sol-red/50")}>{c.said}</span>
              <span className="mt-0.5 block text-sol-text">{c.correct}</span>
            </span>
            <span className="text-right tabular-nums">
              <span className="text-sol-text-dim">{c.base}/{c.reps}</span>
              <span className="mx-1 text-sol-text-dim">→</span>
              <span className={moved ? "text-sol-green" : "text-sol-text-dim"}>{c.arm}/{c.reps}</span>
              <span className="mt-0.5 block font-mono text-[10.5px] text-sol-text-dim">{[c.moment, ...(c.twins ?? []).map((t) => t.moment)].join(" · ")}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The findings waiting proposals rest on, each measured by name: one the edit stops finding is struck through in red. */
function Rests({ rests }: { rests: NonNullable<JudgeFixCard["ab"]["rests"]> }) {
  if (!rests.length) return null;
  const emptied = rests.filter(restEmptied).length;
  return (
    <section className="mt-6" data-judge-fix-rests>
      <h2 className={cn("text-[11px] font-medium uppercase tracking-wide", emptied ? "text-sol-red" : "text-sol-text-dim")}>Waiting proposals · {emptied ? `${emptied} emptied` : `${rests.length} kept`}</h2>
      <ul className="mt-1.5 divide-y divide-sol-border/30 border-y border-sol-border/30">
        {rests.map((r) => {
          const gone = restEmptied(r);
          return (
            <li key={r.card} className="grid grid-cols-[4rem_1fr_auto] items-baseline gap-x-3 py-2 text-[12px]" data-judge-fix-rest={gone ? "emptied" : "kept"}>
              <span className="font-mono text-[11px] text-sol-text-muted">{r.card}</span>
              <span className={cn("min-w-0 truncate font-mono text-[11px] text-sol-text-dim", gone && "text-sol-red line-through decoration-sol-red/50")}>{r.finding} · {r.moment} · {r.problem}</span>
              <span className="tabular-nums">
                <span className="text-sol-text-dim">{r.base}/{r.reps}</span>
                <span className="mx-1 text-sol-text-dim">→</span>
                <span className={gone ? "text-sol-red" : "text-sol-green"}>{r.arm}/{r.reps}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function JudgeFixCardView({ card, answer, problem, overlaps }: { card: JudgeFixCard; answer: ReactNode; problem?: string; overlaps?: CardFactsProps["overlaps"] }) {
  const v = VERDICT[card.ab.verdict];
  const cost = perRun(card);
  return (
    <div data-judge-fix={card.problem}>
      <div className="flex flex-wrap items-baseline gap-x-3 text-[11.5px]">
        {partsOf(card).map((p) => <span key={p} className="rounded bg-sol-cyan/15 px-1.5 py-0.5 text-sol-cyan">{p}</span>)}
        <span className={cn("font-medium", v.tone)} data-judge-fix-verdict={card.ab.verdict}>{v.label}</span>
        <span className="tabular-nums text-sol-text-muted" data-judge-fix-moved>fixes {card.cases.filter(caseMoved).length} of {card.cases.length}</span>
        <span className="tabular-nums text-sol-text-dim">{card.ab.reps}× each side · ${card.ab.cost_usd.toFixed(2)}</span>
        {cost && <span className={cn("tabular-nums", card.ab.usd_per_run!.arm > card.ab.usd_per_run!.base ? "text-sol-yellow" : "text-sol-green")} data-judge-fix-cost>{cost}</span>}
      </div>
      <h1 className="decision-question mt-2 text-sol-text">{card.change}</h1>
      {problem && <p className="mt-1 text-[12px] text-sol-text-muted">{problem}</p>}
      <div className="mt-3"><CardFacts overlaps={overlaps} after={(card.builds_on ?? []).map((b) => ({ card: b.card, where: b.files.map((f) => f.split("/").pop()).join(", ") }))} /></div>

      <section className="mt-5 space-y-3 rounded-md border border-sol-border/40 px-4 py-3">
        <div className="grid grid-cols-[7.5rem_1fr_4.5rem] gap-x-3 text-[10.5px] text-sol-text-dim"><span /><span>published now, then this edit</span><span>runs</span></div>
        <Shift label="Ruled wrong" group={card.ab.ruled} wants="fewer" />
        <Shift label="Kept findings" group={card.ab.controls} wants="more" />
      </section>

      <section className="mt-5">{answer}</section>

      <section className="mt-6 space-y-3" data-judge-fix-diff>
        {card.diff.map((d) => (
          <div key={d.file} className="overflow-hidden rounded-md border border-sol-border/40">
            <div className="border-b border-sol-border/40 bg-sol-bg-alt/40 px-3 py-1 font-mono text-[11px] text-sol-text-dim">{d.file}</div>
            <pre className="overflow-x-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed">
              {d.removed.map((l, i) => <div key={`r${i}`} className="whitespace-pre-wrap text-sol-red"><span className="select-none opacity-60">− </span>{l}</div>)}
              {d.added.map((l, i) => <div key={`a${i}`} className="whitespace-pre-wrap text-sol-green"><span className="select-none opacity-60">+ </span>{l}</div>)}
            </pre>
          </div>
        ))}
      </section>

      <Rests rests={card.ab.rests ?? []} />
      <CaseList title="Fixed by this edit" cases={card.cases.filter(caseMoved)} moved />
      <CaseList title="Not moved by this edit" cases={card.cases.filter((c) => !caseMoved(c))} />
    </div>
  );
}
