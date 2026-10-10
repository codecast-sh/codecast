"use client";
// The loop's leading band (docs/architecture/learning-loop.md LL1): before a
// problem reaches the line, someone wrote what the product should do, a judge
// read what happened against it, and its findings were grouped into problems.
// The Graph draws this as a row above its lanes, the Notebook as the first
// section of its rail, so a newcomer reads the loop from where it starts.
// Each judge says where it runs (LL3): a product's own judges run in the
// product and send findings; codecast's judges run here. A step opens a card
// with what it does, how it is doing and its newest findings, each one a
// "Mark wrong" away from the judge's test set (line-workspace.md LW4), and
// on a judge "Improve this judge" (LL4) with the cases marked wrong.
// "Set up judging" sits where the judges would be when there are none.
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, ArrowDown } from "lucide-react";
import type { LoopStep, LoopSteps } from "../../../lib/line/loopSteps";
import { startJudgingSetup, type WrongCase } from "../../../lib/line/setupJudging";
import { useInboxStore } from "../../../store/inboxStore";
import { dayWords } from "../widgets";
import { usePopover } from "./usePopover";
import "./find.css";

/** A judge: a step that reads what happened and decides what broke (people and lessons report, they do not judge). */
export const isJudgeStep = (s: LoopStep) => s.stage === "judge" && (s.kind === "product" || s.kind === "call");

/** Whether a project has any judge yet: without one, the loop has no way to find problems on its own. */
export const hasJudges = (loop: LoopSteps | null) => !!loop && Object.values(loop.steps).some(isJudgeStep);

/** Where a step runs, in the words a person reads on its chip. */
export function whereWords(s: LoopStep, product: string): string | null {
  if (s.stage === "expect") return null;
  if (s.kind === "person") return "people report";
  if (s.kind === "session") return "sessions report";
  return s.where === "product" ? `runs in ${product}` : "runs here";
}

/** The cases a person marked wrong on a judge, for the brief that improves it. */
function wrongCases(s: LoopStep): WrongCase[] {
  return s.decisions
    .filter((d) => d.labels.some((l) => l.verdict === "wrong"))
    .map((d) => ({ ref: d.subject.ref ?? d.moment ?? d.subject.id, note: d.labels.find((l) => l.verdict === "wrong")?.note ?? null }));
}

const SHOWN_DECISIONS = 4;

/** A step's last day in a word or two, for a chip that has no room for its sentence. */
function countWords(s: LoopStep): string {
  if (s.stage !== "judge" && s.stage !== "observe") return s.health.words;
  if (s.health.tone === "off" || s.health.tone === "new") return s.health.words;
  if (s.health.day > 0) return `${s.health.day.toLocaleString("en-US")} today`;
  return "quiet";
}

function StepCard({ step: s, product, projectId, onClose }: { step: LoopStep; product: string; projectId: string; onClose: () => void }) {
  const me = useInboxStore((st) => (st.currentUser?._id ? String(st.currentUser._id) : null));
  const where = whereWords(s, product);
  const judge = isJudgeStep(s);
  const wrong = judge ? wrongCases(s) : [];
  // The judge's own name as its product or repo knows it: "comms" in product:agentwatch/comms, "tone" in judge:tone.
  const judgeName = s.id.startsWith("judge:") ? s.id.slice("judge:".length) : s.id.split("/")[1] ?? s.source ?? s.label;
  return (
    <div className="lw-pop lw-find-card" role="dialog" aria-label={s.label} data-line-find-card={s.id}>
      <div className="lw-find-card-h">
        <b>{s.label}</b>
        {where && <span className="lw-find-where" data-where={s.where}>{where}</span>}
        {s.mode === "shadow" && <span className="lw-find-where" data-where="shadow">shadow</span>}
      </div>
      <p className="lw-find-card-p">{s.purpose}</p>
      <p className="lw-find-card-h2" data-tone={s.health.tone}>{s.health.words}</p>
      {s.decisions.length > 0 && (
        <ul className="lw-find-decisions">
          {s.decisions.slice(0, SHOWN_DECISIONS).map((d) => {
            const mine = d.labels.find((l) => l.by === me)?.verdict ?? null;
            const marked = mine ?? d.label?.verdict ?? null;
            return (
              <li key={d.id} data-verdict={marked ?? undefined}>
                <span className="lw-find-d-words">{d.decided}</span>
                <span className="lw-find-d-when">{dayWords(d.at)}</span>
                {judge && (
                  <button
                    type="button"
                    className="lw-act"
                    aria-pressed={mine === "wrong"}
                    onClick={() => useInboxStore.getState().labelDecision(d.subject.id, s.id, mine === "wrong" ? null : "wrong")}
                    data-line-find-wrong={d.id}
                  >
                    {mine === "wrong" ? "Marked wrong" : "Mark wrong"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {judge && (
        <div className="lw-find-card-foot">
          <span>{wrong.length ? `${wrong.length} marked wrong, the cases an agent starts from` : "Mark the findings it got wrong first, or ask anyway"}</span>
          <span className="lw-spacer" />
          <button type="button" className="lw-act" data-primary="" onClick={() => { startJudgingSetup(projectId, { judge: judgeName, wrong }); onClose(); }} data-line-improve-judge={s.id}>
            Improve this judge
          </button>
        </div>
      )}
    </div>
  );
}

/** `grouped`: the chip sits under a "runs in ..." label its group shares, so it does not repeat it. */
function StepChip({ step: s, product, projectId, compact, grouped }: { step: LoopStep; product: string; projectId: string; compact?: boolean; grouped?: boolean }) {
  const { open, setOpen, ref } = usePopover();
  const where = whereWords(s, product);
  return (
    <div className="lw-pop-host lw-find-host" ref={ref}>
      <button type="button" className="lw-find-step" data-kind={s.kind} data-tone={s.health.tone} aria-expanded={open} onClick={() => setOpen(!open)} data-line-find-step={s.id} title={s.purpose}>
        <span className="lw-find-name">{s.label}</span>
        {where && !grouped && <span className="lw-find-where" data-where={s.kind === "person" || s.kind === "session" ? "people" : s.where}>{where}</span>}
        <span className="lw-find-health">{compact ? countWords(s) : s.health.words}</span>
      </button>
      {open && <StepCard step={s} product={product} projectId={projectId} onClose={() => setOpen(false)} />}
    </div>
  );
}

function SetUpJudging({ projectId }: { projectId: string }) {
  return (
    <button type="button" className="lw-act" data-primary="" onClick={() => startJudgingSetup(projectId)} data-line-setup-judging="band">
      Set up judging
    </button>
  );
}

/** The columns of the band: expectations, the judges (they observe too), what reports in, problems. */
function columnsOf(loop: LoopSteps) {
  const steps = loop.order.map((id) => loop.steps[id]);
  const expect = steps.filter((s) => s.stage === "expect");
  const observe = steps.filter((s) => s.stage === "observe");
  const judges = steps.filter(isJudgeStep);
  const reporters = steps.filter((s) => s.stage === "judge" && !isJudgeStep(s));
  const group = steps.filter((s) => s.stage === "group");
  return { expect, observe, judges, reporters, group };
}

export type FindBandProps = { loop: LoopSteps | null; projectId: string | null; product?: string | null; layout: "row" | "rail" };

export function FindBand({ loop, projectId, product, layout }: FindBandProps) {
  const [allJudges, setAllJudges] = useState(false);
  const cols = useMemo(() => (loop ? columnsOf(loop) : null), [loop]);
  if (!loop || !cols || !projectId) return null;
  const who = product?.trim() || "the product";
  const rail = layout === "rail";
  // A judge with nothing in the last week stays one press away, so the band shows what is finding problems now.
  const busy = cols.judges.filter((s) => s.health.week > 0);
  const quiet = cols.judges.length - busy.length;
  const judges = allJudges || busy.length === 0 ? cols.judges : busy;
  const chip = (s: LoopStep, compact = rail) => <StepChip key={s.id} step={s} product={who} projectId={projectId} compact={compact} />;
  // Steps that run in the same place share one "runs in ..." label: where each judge runs reads at a glance.
  const byWhere = (list: LoopStep[]) => {
    const groups = new Map<string, LoopStep[]>();
    for (const s of list) {
      const w = whereWords(s, who) ?? "";
      groups.set(w, [...(groups.get(w) ?? []), s]);
    }
    return [...groups].map(([w, steps]) => (
      <div key={w} className="lw-find-group" data-line-find-where={w}>
        {w && <span className="lw-find-where" data-where={steps[0].kind === "person" || steps[0].kind === "session" ? "people" : steps[0].where}>{w}</span>}
        {steps.map((s) => <StepChip key={s.id} step={s} product={who} projectId={projectId} compact grouped />)}
      </div>
    ));
  };

  const col = (key: string, label: string, body: ReactNode) => (
    <div className="lw-find-col" data-col={key}>
      <span className="lw-find-col-h">{label}</span>
      <div className="lw-find-col-b">{body}</div>
    </div>
  );
  const arrow = rail ? null : <ArrowRight className="lw-find-arrow" aria-hidden />;

  return (
    <section className="lw-find" data-layout={layout} aria-label="Find: how problems are found" data-line-find>
      <header className="lw-find-head">
        <b>Find</b>
        <span>{rail ? "how problems are found" : "how problems are found, before the line below fixes them"}</span>
      </header>
      <div className="lw-find-cols">
        {col("expect", "Expectations", cols.expect.map((x) => chip(x)))}
        {arrow}
        {col(
          "judge",
          cols.observe.length ? "Observe, then judge" : "Observe and judge",
          <>
            {byWhere([...cols.observe, ...judges])}
            {cols.judges.length === 0 && <span className="lw-find-none">No judges yet. <SetUpJudging projectId={projectId} /></span>}
            {quiet > 0 && busy.length > 0 && (
              <button type="button" className="lw-link lw-find-more" onClick={() => setAllJudges((v) => !v)} aria-pressed={allJudges}>
                {allJudges ? "Hide the quiet ones" : `${quiet} more, quiet all week`}
              </button>
            )}
            {byWhere(cols.reporters)}
          </>,
        )}
        {arrow}
        {col("group", "Problems", cols.group.map((x) => chip(x)))}
      </div>
      <div className="lw-find-into" aria-hidden><ArrowDown className="w-3.5 h-3.5" />each problem goes to the line</div>
    </section>
  );
}
