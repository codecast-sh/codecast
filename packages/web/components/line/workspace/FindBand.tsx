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
import Link from "next/link";
import { ArrowRight, ArrowDown, ArrowUpRight, ChevronDown, ChevronUp } from "lucide-react";
import { graphPlaceTitle } from "../../../lib/line/lineGraphs";
import { sourceLabel, type LoopStep, type LoopSteps } from "../../../lib/line/loopSteps";
import { startJudgingSetup, type WrongCase } from "../../../lib/line/setupJudging";
import { StartSessionButton, SETUP_JUDGING_WHAT, improveJudgeWhat } from "./StartSessionButton";
import { useInboxStore } from "../../../store/inboxStore";
import { dayWords } from "../widgets";
import { usePopover } from "./usePopover";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { lineRefHref } from "../../../lib/line/lineWorkspaceUrl";
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
  if (s.stage === "group") return "grouped in codecast";
  return s.where === "product" ? `runs in ${product}` : "runs here";
}

/** The header over a group of judges or reporters: where they run, or who reports (LL3). */
export function groupWords(s: LoopStep, product: string): string {
  if (s.kind === "person") return "Reported by people";
  if (s.kind === "session") return "Reported by past sessions";
  return s.where === "product" ? `In ${product}` : "Here";
}

/** The cases a person marked wrong on a judge, for the brief that improves it. */
function wrongCases(s: LoopStep): WrongCase[] {
  return s.decisions
    .filter((d) => d.labels.some((l) => l.verdict === "wrong"))
    .map((d) => ({ ref: d.subject.ref ?? d.moment ?? d.subject.id, note: d.labels.find((l) => l.verdict === "wrong")?.note ?? null }));
}

const SHOWN_DECISIONS = 4;

/** A product source as it names itself on a link ("AgentWatch"), from the step's own label words. */
const sourceName = (source: string) => (source.toLowerCase() === "agentwatch" ? "AgentWatch" : sourceLabel(source));

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
        {/* The version its newest results name (learning-loop.md LL1): an expectations number, or a judge file's blob sha. */}
        {s.version && <span className="lw-find-where" data-where="version" title="The version its newest results name">{/^\d+$/.test(s.version) ? `v${s.version}` : s.version.slice(0, 7)}</span>}
      </div>
      <p className="lw-find-card-p">{s.purpose}</p>
      <p className="lw-find-card-h2" data-tone={s.health.tone}>{s.health.words}</p>
      {s.decisions.length > 0 && <span className="lw-find-list-h">{judge ? "Recent findings" : "Recent"}</span>}
      {s.decisions.length > 0 && (
        <ul className="lw-find-decisions">
          {s.decisions.slice(0, SHOWN_DECISIONS).map((d) => {
            const mine = d.labels.find((l) => l.by === me)?.verdict ?? null;
            const marked = mine ?? d.label?.verdict ?? null;
            // Each finding opens what it judged: the product's own case where it was seen, else its place on the line.
            const ref = d.subject.ref ?? d.moment;
            const words = <><span className="lw-find-d-words">{d.decided}</span>{(d.evidenceUrl || ref) && <ArrowUpRight className="lw-find-d-go" aria-hidden />}</>;
            return (
              <li key={d.id} data-verdict={marked ?? undefined}>
                {d.evidenceUrl ? (
                  <a className="lw-find-d-open" href={d.evidenceUrl} target="_blank" rel="noreferrer" title={`Open this case in ${s.source ? sourceName(s.source) : product}`} data-line-find-open={d.id}>{words}</a>
                ) : ref ? (
                  <Link className="lw-find-d-open" href={lineRefHref(ref)} title="Open what it judged" data-line-find-open={d.id}>{words}</Link>
                ) : <span className="lw-find-d-open">{words}</span>}
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
        // Secondary until a finding is marked wrong: the marks are the cases the session starts from (LL4).
        <div className="lw-find-card-foot">
          <span className="lw-spacer" />
          <StartSessionButton primary={wrong.length > 0} what={improveJudgeWhat(s.label, wrong.length)} start={() => { startJudgingSetup(projectId, { judge: judgeName, wrong }); onClose(); }} data={{ "data-line-improve-judge": s.id }}>
            Improve this judge{wrong.length ? ` · ${wrong.length} marked wrong` : ""}
          </StartSessionButton>
        </div>
      )}
    </div>
  );
}

/** `grouped`: the chip sits under a header its group shares ("In Union", "Here"), so it does not repeat where it runs. */
/** `bare`: the column header already names the step ("Expectations"), so the chip carries only its counts. */
function StepChip({ step: s, product, projectId, compact, grouped, bare }: { step: LoopStep; product: string; projectId: string; compact?: boolean; grouped?: boolean; bare?: boolean }) {
  const { open, setOpen, ref } = usePopover();
  const where = whereWords(s, product);
  return (
    <div className="lw-pop-host lw-find-host" ref={ref}>
      <button type="button" className="lw-find-step" data-bare={bare ? "" : undefined} data-kind={s.kind} data-tone={s.health.tone} aria-expanded={open} onClick={() => setOpen(!open)} data-line-find-step={s.id} title={s.purpose}>
        {!bare && <span className="lw-find-name">{s.label}</span>}
        {where && !grouped && <span className="lw-find-where">{where}</span>}
        <span className="lw-find-health">{compact ? countWords(s) : s.health.words}</span>
      </button>
      {open && <StepCard step={s} product={product} projectId={projectId} onClose={() => setOpen(false)} />}
    </div>
  );
}

function SetUpJudging({ projectId }: { projectId: string }) {
  return (
    <StartSessionButton primary what={SETUP_JUDGING_WHAT} start={() => startJudgingSetup(projectId)} data={{ "data-line-setup-judging": "band" }}>
      Set up judging
    </StartSessionButton>
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

/** A fix line the band hands problems to, with the waiting problems it holds (lineGraphs ProjectGraph). */
export type FindRoute = { key: string; waiting: number | null };

export type FindBandProps = {
  loop: LoopSteps | null; projectId: string | null; product?: string | null; layout: "row" | "rail";
  /** The project's fix lines and how many never-run problems wait on none, so the band's last line adds up to the queue. */
  routes?: ReadonlyArray<FindRoute>; neverRun?: number;
  /** Something shares the pane (the step drawer): the band rests as its one-line summary, whatever the reader last chose. */
  squeezed?: boolean;
};

/** Where problems go next, in counts that add up to the waiting queue:
 *  "Each problem goes to one fix line: Fixes in Union (11 waiting) or Fixes here (5 waiting). 48 more have not run on either yet." */
export function routeWords(routes: ReadonlyArray<FindRoute>, neverRun: number, product: string | null, short = false): string {
  if (short && routes.length) {
    // The collapsed row: "to Fixes in Union (11) or Fixes here (5), 48 not run yet".
    const named = routes.map((r) => `${graphPlaceTitle(r.key, product)}${r.waiting != null ? ` (${r.waiting})` : ""}`);
    return `to ${named.length > 1 ? `${named.slice(0, -1).join(", ")} or ${named[named.length - 1]}` : named[0]}${neverRun ? `, ${neverRun} not run yet` : ""}`;
  }
  if (!routes.length) return neverRun ? `each problem goes to the line; ${neverRun} waiting` : "each problem goes to the line";
  const named = routes.map((r) => `${graphPlaceTitle(r.key, product)}${r.waiting != null ? ` (${r.waiting} waiting)` : ""}`);
  const head = named.length === 1 ? `Each problem goes to ${named[0]}` : `Each problem goes to one fix line: ${named.slice(0, -1).join(", ")} or ${named[named.length - 1]}`;
  const rest = neverRun ? ` ${neverRun} more ${neverRun === 1 ? "has" : "have"} not run on ${routes.length === 1 ? "it" : "either"} yet.` : "";
  return `${head}.${rest}`;
}

/** The band's one-row summary once it has been seen: who finds problems, and how many came in today. */
function summaryWords(cols: ReturnType<typeof columnsOf>, product: string): string {
  const inProduct = cols.judges.filter((s) => s.where === "product").length + cols.observe.filter((s) => s.where === "product").length;
  const here = cols.judges.length + cols.observe.length - inProduct;
  const who = [inProduct && `${inProduct} ${inProduct === 1 ? "source" : "sources"} in ${product}`, here && `${here} here`, cols.reporters.some((s) => s.kind === "person") && "people"].filter(Boolean) as string[];
  const day = cols.group[0]?.health.day ?? 0;
  const found = who.length ? `Found by ${who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}` : who[0]}` : "No judges yet";
  return day ? `${found} · ${day.toLocaleString("en-US")} findings today` : found;
}

// Open on the first visit, one summary row after (learning-loop.md LL1): the graph is what a returning reader came for.
const OPEN_KEY = "line.findBand";
const readOpen = (): boolean => {
  try {
    const v = localStorage.getItem(OPEN_KEY);
    if (v === null) { localStorage.setItem(OPEN_KEY, "closed"); return true; }
    return v === "open";
  } catch { return true; }
};

export function FindBand({ loop, projectId, product, layout, routes = [], neverRun = 0, squeezed = false }: FindBandProps) {
  const [allJudges, setAllJudges] = useState(false);
  const [stored, setStored] = useState(readOpen);
  // Opened by hand while squeezed: shown for now, the stored choice untouched; the next squeeze starts folded again.
  const [peek, setPeek] = useState(false);
  useWatchEffect(() => setPeek(false), [squeezed]);
  const open = squeezed ? peek : stored;
  const setOpen = (v: boolean) => {
    if (squeezed) { setPeek(v); return; }
    setStored(v);
    try { localStorage.setItem(OPEN_KEY, v ? "open" : "closed"); } catch { /* private mode */ }
  };
  const cols = useMemo(() => (loop ? columnsOf(loop) : null), [loop]);
  if (!loop || !cols || !projectId) return null;
  const who = product?.trim() || "the product";
  const rail = layout === "rail";
  // A judge with nothing in the last week stays one press away, so the band shows what is finding problems now.
  const busy = cols.judges.filter((s) => s.health.week > 0);
  const quiet = cols.judges.length - busy.length;
  const judges = allJudges || busy.length === 0 ? cols.judges : busy;
  const chip = (s: LoopStep, header: string) => <StepChip key={s.id} step={s} product={who} projectId={projectId} compact={rail} bare={s.label === header} />;
  // Steps that run in the same place sit under one header ("In Union", "Here", "Reported by people"):
  // where each judge runs reads at a glance, and the header is plainly not one more judge.
  const byWhere = (list: LoopStep[]) => {
    const groups = new Map<string, LoopStep[]>();
    for (const s of list) {
      const w = groupWords(s, who);
      groups.set(w, [...(groups.get(w) ?? []), s]);
    }
    return [...groups].map(([w, steps]) => (
      <div key={w} className="lw-find-group" data-line-find-where={w}>
        <span className="lw-find-group-h">{w}</span>
        <div className="lw-find-group-b">
          {steps.map((s) => <StepChip key={s.id} step={s} product={who} projectId={projectId} compact grouped />)}
        </div>
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
  const into = routeWords(routes, neverRun, product?.trim() || null);

  // Folded: one line. The graph folds it while a step's drawer is open, the Notebook's rail keeps it folded so its outline leads.
  if (!open) {
    return (
      <section className="lw-find" data-layout={layout} data-collapsed="" aria-label="Find: how problems are found" data-line-find>
        <button type="button" className="lw-find-summary" onClick={() => setOpen(true)} aria-expanded={false} data-line-find-expand>
          <b>Find</b>
          <span className="lw-find-summary-w">{summaryWords(cols, who)}</span>
          {!rail && <span className="lw-find-summary-into"><ArrowDown className="w-3.5 h-3.5" aria-hidden />{routeWords(routes, neverRun, product?.trim() || null, true)}</span>}
          <ChevronDown className="lw-find-summary-chev" aria-hidden />
        </button>
      </section>
    );
  }

  return (
    <section className="lw-find" data-layout={layout} aria-label="Find: how problems are found" data-line-find>
      <header className="lw-find-head">
        <b>Find</b>
        <span>{rail ? "how problems are found" : "how problems are found, before the line below fixes them"}</span>
        {(!rail || squeezed) && (
          <button type="button" className="lw-link lw-find-collapse" onClick={() => setOpen(false)} aria-expanded data-line-find-collapse>
            Collapse<ChevronUp className="w-3 h-3" aria-hidden />
          </button>
        )}
      </header>
      <div className="lw-find-cols">
        {col("expect", "Expectations", cols.expect.map((x) => chip(x, "Expectations")))}
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
        {col("group", "Problems", cols.group.map((x) => chip(x, "Problems")))}
      </div>
      <div className="lw-find-into" data-line-find-into><ArrowDown className="w-3.5 h-3.5" aria-hidden />{into}</div>
    </section>
  );
}
