"use client";
// A step's work (line-journeys.md LJ8.6): one row per problem under Waiting,
// Failed (grouped by cause, the cause its heading) or Passed. A row is the
// problem's whole title; open, it is the real thing. At a person's step a
// waiting row is the decision itself, answered there (WaitingItem), and an
// answered one the decision with its answer. At an agent's or a script's step
// an open row says what the step was given, what it concluded and what it
// reported, in words a person uses, with the brief and the session on demand.
// One act by state: a failed row starts the problem again (through its
// review), a passed one is marked right or wrong.
import { memo, useMemo, useRef, useState, type ReactNode } from "react";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { ChevronRight, RotateCcw } from "lucide-react";
import type { LineModel, LineStep, StepDecision } from "../../../../lib/line/lineModel";
import { decisionSaid } from "../../../../lib/line/lineModel";
import type { LineNeed } from "../../../../lib/line/lineNeeds";
import { NOT_LANDED, stationCatalogWords } from "../../../../lib/line/runReport";
import { plainOutcome, spendCapWords, visitDecision, type FailGroup, type Stall, type StepShow, type StepWork, type WorkRow } from "../../../../lib/line/stepWork";
import { problemListName, type ProblemRow } from "../../../../lib/line/problemTable";
import { waitOwner } from "../../../../lib/line/stepTable";
import { causeName } from "../../../../lib/lineFlow";
import { decisionOutput, visitOutputWords } from "../../../../lib/line/visitOutput";
import { ageShort } from "../../../../lib/lineFlow";
import type { LineWorkspace } from "../../../../hooks/useLineWorkspace";
import { useInboxStore } from "../../../../store/inboxStore";
import { LineDecision } from "../../widgets/LineDecision";
import { ReviewSummary, WaitingItem } from "../../widgets/WaitingItem";
import { NavLink, dayWords, useLineNav } from "../../widgets/parts";
import { StartRunAct } from "../../widgets/StartRunAct";
import { StepVisit } from "./StepVisit";
import { BranchName, ClosedDecisionActs, useRunBranch } from "../../widgets/ClosedDecisionActs";
import { MergeFixAct } from "../views/problem/MergeFixAct";
import { CloseAsFixed } from "../views/problem/CloseProblem";
import { StartTheseAgain, type AgainCause } from "../views/timeline/StartTheseAgain";
import { blockerFile } from "../../../../lib/line/blocker";
import { BlockerFix } from "./BlockerFix";

type Card = { _id: string; short_id?: string; status: string; workflow_run_id?: string; gate_node_id?: string; created_at?: number; resolved_at?: number; options?: Array<{ label: string }>; answer_index?: number; answer_text?: string };

/** The rows a list paints before "Show all": a long Passed list is not what a person came for. */
const PAGE = 40;

export type StepWorkListProps = {
  step: LineStep;
  model: LineModel;
  /** The rows and names an opened visit reads (the run row, its task, who answered). */
  ws: Pick<LineWorkspace, "rows" | "names" | "projects">;
  work: StepWork;
  show: StepShow | null;
  labels: Record<StepShow, string>;
  needs: ReadonlyArray<LineNeed>;
  /** The open row (a problem's key), and how to open another. */
  openKey: string | null;
  onOpen: (key: string | null) => void;
  /** Open Instructions with these runs as the test set (a cause heading's act). */
  onEditFor?: (runs: string[]) => void;
  /** Open problems with the line about this step (problemTable lineProblemsAt): a failure here is theirs to fix. */
  holders?: ReadonlyArray<ProblemRow>;
  /** Problems' rows, by problem: a cause heading starts again the ones Problems files under Failed, through its review. */
  problems?: ReadonlyArray<ProblemRow>;
  now: number;
};

export function StepWorkList({ step, model, ws, work, show, labels, needs, openKey, onOpen, onEditFor, holders, problems, now }: StepWorkListProps) {
  const failedProblems = useMemo(() => new Map((problems ?? []).filter((p) => p.stand.status === "failed").map((p) => [p.id, p])), [problems]);
  const shows = (k: StepShow) => !show || show === k;
  const row = (r: WorkRow) => <Row key={r.key} r={r} step={step} model={model} ws={ws} needs={needs} open={openKey === r.key} onToggle={() => onOpen(openKey === r.key ? null : r.key)} now={now} />;
  const total = work.counts.waiting + work.counts.failed + work.counts.passed + work.replaced.length + work.closed.length + work.movedOn.length;
  if (!total) return <div className="sp-none" data-line-step-empty>Nothing has reached {step.label} yet.</div>;
  if (show && !work.counts[show]) return <div className="sp-none" data-line-step-empty>None {labels[show].toLowerCase()}.</div>;
  return (
    <div className="sp-work" data-line-step-work={step.id}>
      {shows("waiting") && <WaitingGroups rows={work.waiting} step={step} needs={needs} row={row} openKey={openKey} />}
      {/* One step's open problems with the line hold every run that failed here: said once, above its causes. */}
      {shows("failed") && work.failed.length > 0 && !!holders?.length && <HeldBy held={holders} />}
      {shows("failed") && work.failed.map((g) => <FailSection key={g.key} g={g} step={step} row={row} onEditFor={onEditFor} held={!!holders?.length} problems={failedProblems} ws={ws} />)}
      {shows("passed") && work.passed.length > 0 && <Paged name={labels.passed} kind="passed" rows={work.passed} row={row} openKey={openKey} />}
      {!show && work.replaced.length > 0 && <Paged name="Replaced by a newer run" kind="replaced" rows={work.replaced} row={row} openKey={openKey} folded />}
      {(!show || show === "failed") && work.movedOn.length > 0 && <Paged name="Failed, moved on since" kind="moved" rows={work.movedOn} row={row} openKey={openKey} folded />}
      {(!show || show === "failed") && work.closed.length > 0 && <Paged name="Failed, problem closed since" kind="closed" rows={work.closed} row={row} openKey={openKey} folded />}
    </div>
  );
}

function Section({ name, n, kind, children, act, lead, thin }: { name: string; n: number; kind: string; children: ReactNode; act?: ReactNode; lead?: ReactNode; thin?: boolean }) {
  return (
    <section className="sp-sec" data-line-step-group={kind} data-count={n} data-thin={thin ? "" : undefined}>
      <header className="sp-sec-h">
        <h3><span className="lw-num">{n}</span> {name}</h3>
        {act}
      </header>
      {lead}
      <div className="sp-rows">{children}</div>
    </section>
  );
}

/** Causes no instruction fixes: a session that never started, one that sat empty, a runner that stopped, a spend cap. */
const NO_EDIT_CAUSE = /^(nosession|runner-|budget:|sentback:|infra:|quiet:)/;

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Runs that hit their limit together, said first: one stall, when, on how many machines, and whether their sessions
 *  ever started. Starting them again one by one sends each into the same stall. */
function StallLead({ s, of }: { s: Stall; of: number }) {
  const day = dayWords(s.to);
  return (
    <p className="sp-stall" data-line-step-stall={s.n}>
      <b>One stall, not separate failures.</b>{" "}
      <span className="lw-num">{s.n}</span>{s.n < of ? <> of these <span className="lw-num">{of}</span></> : ""} runs hit the limit between <span className="lw-num">{clock(s.from)}</span> and <span className="lw-num">{clock(s.to)}</span>{day ? ` ${day}` : ""}
      {s.machines > 1 ? <>, on <span className="lw-num">{s.machines}</span> machines</> : ", on one machine"}
      {s.empty === s.n ? ". None of their sessions ran a turn." : s.empty ? <>. <span className="lw-num">{s.empty}</span> of their sessions never ran a turn.</> : "."}
    </p>
  );
}

/** One cause of failure: how many problems it stopped, in plain words, with the act that fixes the cause. */
/** Causes that are the machine's, not the step's: a stall, a session that never started, a runner that stopped, one the
 *  line stopped when it went quiet. Started again together, through the review that names the machines and holds the
 *  start while none works. */
const RESTART_CAUSE = /^(nosession|runner-|quiet:)/;

function FailSection({ g, step, row, onEditFor, held, problems, ws }: { g: FailGroup; step: LineStep; row: (r: WorkRow) => ReactNode; onEditFor?: (runs: string[]) => void; held: boolean; problems: ReadonlyMap<string, ProblemRow>; ws: StepWorkListProps["ws"] }) {
  const [again, setAgain] = useState<AgainCause | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  // The same problems Problems lists under this cause and would start again: those it files as failed.
  const restart = !held && (!!g.stall || RESTART_CAUSE.test(g.key)) ? g.rows.map((r) => (r.d.caseId ? problems.get(r.d.caseId) : undefined)).filter((p): p is ProblemRow => !!p) : [];
  const projectName = (id: string | null) => (id ? ws.projects.find((p) => p._id === id)?.title ?? null : null);
  // An unanswered question is fixed by answering or asking it again, never by editing its prompt; a stall is fixed where
  // the runs ran, never in the step's instructions. A script fails on what it runs (the project's command, the machine's
  // setup), never on its own text: the problem that owns that is the act.
  // A station blocked by a bug in a file it runs is cleared by that file's fix: its words whole, and the fix as the act.
  const blocker = g.key.startsWith("blocked:") ? g.rows.find((r) => r.blocked)?.blocked ?? null : null;
  const file = blockerFile(blocker);
  const editable = !held && !file && !!step.prompt && step.kind === "agent" && !!onEditFor && !g.stall && !NO_EDIT_CAUSE.test(g.key);
  const visits = g.rows.reduce((n, r) => n + 1 + (r.again?.length ?? 0), 0);
  const lead = g.stall ? <StallLead s={g.stall} of={visits} /> : blocker ? <p className="sp-stall" data-line-step-blocker=""><b>{step.label} said:</b> {blocker}</p> : undefined;
  return (
    <Section name={g.label} n={g.rows.length} kind="failed" thin={g.thin} lead={lead} act={file && blocker ? (
      <BlockerFix file={file} reason={blocker} step={step.label} problems={blockedProblems(g.rows)} />
    ) : editable ? (
      <button type="button" className="lw-act" onClick={() => onEditFor!(g.rows.map((r) => r.d.runId))} data-line-step-fix={g.key}>Edit instructions</button>
    ) : restart.length ? (
      <span className="lw-closed-acts">
        {refused && <span className="lwp-sub-err" role="alert">{refused}</span>}
        <button type="button" className="lw-act" aria-haspopup="dialog" onClick={() => { setRefused(null); setAgain({ key: g.key, label: g.label, rows: restart }); }} data-line-start-again={g.key}>{restart.length === 1 ? "Start again…" : "Start these again…"}</button>
      </span>
    ) : undefined}>
      {g.rows.map(row)}
      {again && <StartTheseAgain again={again} workspace={ws} projectName={projectName} onClose={() => setAgain(null)} onRefused={setRefused} />}
    </Section>
  );
}

/** The problems a blocker holds, by id and ref. */
const blockedProblems = (rows: ReadonlyArray<WorkRow>) => rows.flatMap((r) => (r.d.caseId ? [{ id: r.d.caseId, ref: r.d.caseRef ?? null }] : []));

/** The open problems with the line about this step, as Problems' Failed headings name them: each opens its problem. */
function HeldBy({ held }: { held: ReadonlyArray<ProblemRow> }) {
  const nav = useLineNav();
  return (
    <div className="sp-held" data-line-step-held={held.length}>
      {held.map((h) => (
        <div key={h.id} data-line-held-by={h.issue.ref ?? h.id}>
          <NavLink className="sp-held-row" href={nav.caseHref?.(h.id) ?? null} onOpen={() => nav.openCase?.(h.id)}>
            <span className="sp-held-k">Same cause</span>
            <span className="sp-held-ref">{h.issue.ref}</span>
            <span className="sp-held-name">{problemListName(h.issue)}</span>
            <span className="sp-held-st" data-status={h.stand.status}>{h.stand.phrase}</span>
          </NavLink>
        </div>
      ))}
    </div>
  );
}

/** What waits, by whose move it is (waitOwner, the Steps table's own split): what is on the viewer first, then what
 *  someone else holds, then what is only running, folded under its count while anything above waits on a person, so the
 *  "on you" a badge or a cell named is the list it opens on. */
const OWNER_GROUPS = [["you", "On you"], ["others", "On someone else"], ["running", "Running now"]] as const;
function WaitingGroups({ rows, step, needs, row, openKey }: { rows: WorkRow[]; step: LineStep; needs: ReadonlyArray<LineNeed>; row: (r: WorkRow) => ReactNode; openKey: string | null }) {
  if (!rows.length) return null;
  const by = { you: [] as WorkRow[], others: [] as WorkRow[], running: [] as WorkRow[] };
  for (const r of rows) by[waitOwner(r, step.kind, needs)].push(r);
  const onPerson = by.you.length + by.others.length > 0;
  return (
    <>
      {OWNER_GROUPS.map(([k, name]) => by[k].length > 0 && (
        k === "running" && onPerson
          ? <Paged key={k} name={name} kind="running" rows={by[k]} row={row} openKey={openKey} folded />
          : <Section key={k} name={name} n={by[k].length} kind={k === "running" ? "running" : "waiting"}>{by[k].map(row)}</Section>
      ))}
    </>
  );
}

/** A long list, a page at a time; the open row is always among those shown. */
function Paged({ name, kind, rows, row, openKey, folded }: { name: string; kind: string; rows: WorkRow[]; row: (r: WorkRow) => ReactNode; openKey: string | null; folded?: boolean }) {
  const [all, setAll] = useState(false);
  const [shut, setShut] = useState(!!folded);
  const at = openKey ? rows.findIndex((r) => r.key === openKey) : -1;
  const shown = all ? rows : rows.slice(0, Math.max(PAGE, at + 1));
  if (folded && shut && at < 0) {
    return (
      <section className="sp-sec" data-line-step-group={kind} data-count={rows.length}>
        <button type="button" className="sp-sec-fold" onClick={() => setShut(false)} aria-expanded={false}><ChevronRight aria-hidden /><span className="lw-num">{rows.length}</span> {name.toLowerCase()}</button>
      </section>
    );
  }
  return (
    <Section name={name} n={rows.length} kind={kind}>
      {shown.map(row)}
      {shown.length < rows.length && <button type="button" className="sp-more" onClick={() => setAll(true)}>Show all {rows.length}</button>}
    </Section>
  );
}

/** A finished step's yes, by whose it is (waitOwner, the table's own split): the viewer's, else someone else's. */
const STOPPED_WORDS = { you: "Finished; needs your yes to go on", others: "Finished; needs someone else's yes", running: "Finished; needs a yes" } as const;

/** The viewer's "already fixed on main" wait a row is. */
const fixedNeed = (r: WorkRow, needs: ReadonlyArray<LineNeed>): LineNeed | null => (r.ask?.kind === "fixed" ? needs.find((n) => n.kind === "fixed" && n.runId === r.d.runId) ?? null : null);

/** What a closed row says under its title: what the step concluded, in a line. */
function rowLine(r: WorkRow, step: LineStep, needs: ReadonlyArray<LineNeed>): { tag: string | null; tone?: string; text: string | null } {
  const d = r.d;
  if (r.state === "waiting") return { tag: null, text: null };
  if (r.state === "running") return { tag: "Running now", tone: "live", text: null };
  // A run that found main already fixes it waits on a close, never a go-on: said by that act, in the band's words.
  if (r.ask?.kind === "fixed") { const sha = fixedNeed(r, needs)?.sha; return { tag: `Already fixed on main${sha ? ` (${sha.slice(0, 7)})` : ""}: close it?`, tone: "person", text: null }; }
  if (r.state === "stopped") return { tag: STOPPED_WORDS[waitOwner(r, step.kind, needs)], tone: "person", text: null };
  // Replaced: where its problem stands now, in Problems' words ("Failed at Implement"), when Problems lists it.
  if (r.state === "replaced") return { tag: r.now ?? null, text: null };
  // Failed here, and the problem stands elsewhere now: where, in Problems' words.
  if (r.now) return { tag: r.now, text: null };
  // An approved fix nothing merged: what its landing step said ("Not merged: merge off"), else that it waits to merge.
  if (r.state === "unlanded") return { tag: NOT_LANDED.test(d.decided.words) ? d.decided.words : "Approved, not merged", tone: "person", text: null };
  // Handed off for review: what the review needs, in the station's own sentence, else the gate it left red.
  if (r.state === "review") return { tag: "Waiting on a review", tone: "person", text: r.review?.ask ?? (r.review?.gate ? `Handed off with ${r.review.gate}` : null) };
  const out = decisionOutput(step.kind, d);
  if (step.kind === "person") {
    // A no-answer row sits under its state's own heading (Lapsed, Withdrawn): its line says why, when the run said.
    if (d.answer && d.answer.state !== "answered") return { tag: null, text: d.answer.why };
    const tag = d.answer ? d.answer.words : plainOutcome(out?.kind === "choice" ? out.choice : d.decided.toWords ?? d.decided.words);
    return { tag: tag || null, tone: "person", text: out?.kind === "choice" ? out.note : out?.kind === "text" ? out.text : null };
  }
  // The group's heading says the cause: the line under a failed row says only what the heading does not.
  if (r.state === "failed") {
    // A spend cap says whose budget, how full, and when it runs again: never the trigger's id or the station's paragraph.
    if (r.cause?.key.startsWith("budget:")) return { tag: null, text: spendCapWords(d, clock) };
    // A blocker's words lead its group whole: the row does not say them again.
    if (r.cause?.key.startsWith("blocked:")) return { tag: null, text: null };
    const t = visitOutputWords(out);
    // The line's own label for a failed step ("Could not write a test for the problem") claims what nobody said: no line.
    if (!t || stationCatalogWords(d.id.slice(d.runId.length + 1), t)) return { tag: null, text: null };
    return { tag: null, text: r.cause && restates(t, r.cause.label) ? null : t };
  }
  const own = d.decided.outcome ?? d.decided.toWords;
  return { tag: own ? plainOutcome(own) : null, text: out?.kind === "text" ? out.text : decisionSaid(d) === d.decided.words ? null : decisionSaid(d) };
}

/** Whether a line only says its heading again ("Ran out of time after 30m and was killed" under "Out of time, 30m"). */
function restates(text: string, heading: string): boolean {
  const words = (x: string) => new Set(x.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const head = words(heading);
  if (!head.size) return false;
  const said = words(text);
  let shared = 0;
  for (const w of head) if (said.has(w)) shared++;
  return shared / head.size >= 0.6 && said.size <= head.size * 3;
}

const Row = memo(function Row({ r, step, model, ws, needs, open, onToggle, now }: { r: WorkRow; step: LineStep; model: LineModel; ws: StepWorkListProps["ws"]; needs: ReadonlyArray<LineNeed>; open: boolean; onToggle: () => void; now: number }) {
  const d = r.d;
  const nav = useLineNav();
  // A built fix waiting on review says, shut, what its review would: the gate it left red, how far main moved under it,
  // and its act. Its builder's hand-off line is not that (it can say "green" over a red gate).
  const reviewNeed = (r.state === "review" || r.state === "unlanded") ? needs.find((n) => n.runId === d.runId && (n.kind === "review" || n.kind === "unlanded")) ?? null : null;
  const fixed = fixedNeed(r, needs);
  const said = rowLine(r, step, needs);
  const line = reviewNeed ? { ...said, text: null } : said;
  const since = d.at ? ageShort(now - d.at) : null;
  const times = (r.again?.length ?? 0) + 1;
  // Two problems can share a title: the ref tells them apart, read from the store when the run row did not carry it.
  const storeRef = useInboxStore((s) => (!d.caseRef && d.caseId ? (s.tasks as Record<string, { short_id?: string }> | undefined)?.[d.caseId]?.short_id ?? null : null));
  const ref = d.caseRef ?? storeRef;
  // The problem by the name every list gives it (its written name, else its title to a whole clause), never a stored cut.
  const named = useInboxStore((s) => (d.caseId ? causeName((s.tasks as Record<string, Parameters<typeof causeName>[0]> | undefined)?.[d.caseId]) : null));
  const title = problemListName({ title: d.caseTitle, name: named });
  // Opened, a row whose body runs past the viewport's foot moves its head to the top, so a docked answer is on screen.
  const el = useRef<HTMLElement>(null);
  useWatchEffect(() => {
    if (!open) return;
    // A timer, not a frame: a background tab stalls frames.
    const id = window.setTimeout(() => { const r = el.current?.getBoundingClientRect(); if (r && r.bottom > window.innerHeight) el.current!.scrollIntoView?.({ block: "start" }); }, 0);
    return () => window.clearTimeout(id);
  }, [open]);
  return (
    <article ref={el} className="sp-row" data-open={open ? "" : undefined} data-state={r.state} data-line-step-row={r.key} data-run={d.runId}>
      <div className="sp-row-h">
        <button type="button" className="sp-row-tog" aria-expanded={open} onClick={onToggle}>
          <ChevronRight className="sp-row-caret" aria-hidden />
          <span className="sp-row-main">
            <span className="sp-row-title" title={title === d.caseTitle ? undefined : d.caseTitle}>{title}</span>
            {(line.tag || line.text || times > 1) && (
              <span className="sp-row-said">
                {line.tag && <span className="sp-tag" data-tone={line.tone}>{line.tag}</span>}
                {times > 1 && <span className="sp-tag" data-tone="bad">{times} times</span>}
                {line.text && <span>{line.text}</span>}
              </span>
            )}
          </span>
        </button>
        <span className="sp-row-meta lw-num">
          {/* The ref is the problem's own link: the row's title stays the problem, open or shut. */}
          {ref && (d.caseId && nav.openCase
            ? <NavLink className="sp-row-ref" href={nav.caseHref?.(d.caseId) ?? null} onOpen={() => nav.openCase!(d.caseId!)}>{ref}</NavLink>
            : <span className="sp-row-ref">{ref}</span>)}
          {since && <span title={d.at ? new Date(d.at).toLocaleString() : undefined}>{r.state === "waiting" ? `waiting ${since}` : since}</span>}
        </span>
      </div>
      {reviewNeed && !open && <div className="sp-row-sum"><ReviewSummary need={reviewNeed} /></div>}
      {/* A fix main already carries is finished from the row: its close, without opening it. */}
      {fixed?.caseId && fixed.sha && !open && <div className="sp-row-sum" data-line-step-close-fixed=""><CloseAsFixed taskRef={fixed.problemRef ?? fixed.caseId} sha={fixed.sha} projectId={fixed.projectId ?? null} taskId={fixed.caseId} /></div>}
      {open && <div className="sp-row-b">{step.kind === "person" || r.ask || r.state === "stopped" || r.state === "review" || r.state === "unlanded" ? <Thing r={r} step={step} model={model} ws={ws} needs={needs} now={now} /> : <Visit r={r} step={step} model={model} ws={ws} />}</div>}
    </article>
  );
});

/** The decision of one visit to a person's step, any status: its ref, and how it was answered. */
function useVisitCard(runId: string, stepId: string, status: "pending" | "any"): Card | null {
  const sig = useInboxStore((s) => {
    const st = s as unknown as { lineCards?: Record<string, Card>; sessionDecisions?: Record<string, Card> };
    const c = visitDecision([...Object.values(st.sessionDecisions ?? {}), ...Object.values(st.lineCards ?? {})], runId, stepId, status);
    return c ? JSON.stringify({ _id: c._id, short_id: c.short_id, status: c.status, created_at: c.created_at, resolved_at: c.resolved_at, answer_index: c.answer_index, answer_text: c.answer_text, options: c.options?.map((o) => ({ label: o.label })) }) : "";
  });
  return useMemo(() => (sig ? (JSON.parse(sig) as Card) : null), [sig]);
}

/** A waiting or answered row at a person's step, and a run that stopped needing a yes: the thing itself, in a box of its own height. */
function Thing({ r, step, model, ws, needs, now }: { r: WorkRow; step: LineStep; model: LineModel; ws: StepWorkListProps["ws"]; needs: ReadonlyArray<LineNeed>; now: number }) {
  const nav = useLineNav();
  const d = r.d;
  const waits = r.state === "waiting" || r.state === "stopped" || r.state === "review" || r.state === "unlanded";
  const need = waits ? needs.find((n) => n.runId === d.runId) ?? needs.find((n) => !!d.caseId && n.caseId === d.caseId) ?? null : null;
  const card = useVisitCard(d.runId, step.id, waits ? "pending" : "any");
  const problem = useProblemState(d.caseId);
  const toProblem = (id: string) => nav.openCase?.(id);
  const toRun = (runId: string, caseId: string | null) => nav.openRun(runId, caseId);
  // The row's head already names the problem, its ref and how long it has waited: the decision opens on its question,
  // in the page's flow, its answers docked at the viewport's foot.
  if (need) {
    const flow = need.kind === "decision" || need.kind === "lapsed";
    return <div className="sp-thing" data-flow={flow ? "" : undefined} data-line-step-thing="need"><WaitingItem need={need} now={now} head={false} inline={flow} /></div>;
  }
  // Lapsed or withdrawn: the question as it was asked, closed, and its answers as acts that still work (Drop closes the
  // problem now; Ask again is a new run), the one it recommended first.
  const unanswered = r.state === "failed" && !!d.answer && d.answer.state !== "answered";
  const closedState = d.answer?.state === "lapsed" ? "lapsed" : "withdrawn";
  const again = unanswered && problem && !problem.closed && d.caseId ? (
    <ClosedDecisionActs decisionRef={card ? card.short_id ?? card._id : d.answer?.ref ?? null} state={closedState} taskId={d.caseId} taskRef={d.caseRef ?? problem.ref} title={d.caseTitle} projectId={problem.projectId} branch={closedState === "lapsed"} />
  ) : null;
  if (card) {
    return (
      <>
        <div className="sp-thing" data-flow="" data-line-step-thing="decision"><LineDecision id={card.short_id ?? card._id} onProblem={toProblem} onRun={toRun} head={false} inline act={!unanswered} /></div>
        {unanswered && <div className="sp-detail sp-detail-foot"><Foot d={d}>{again}</Foot></div>}
      </>
    );
  }
  // An agent's step that stopped with nothing asked of anyone yet: what it concluded is the thing.
  if (step.kind !== "person") return <Visit r={r} step={step} model={model} ws={ws} />;
  // No decision reached this visit: say so, why when the run said, and where its run is.
  return (
    <div className="sp-detail" data-line-step-thing="none">
      <p className="sp-said">{waits ? "This run reached the step, and no decision was presented for it."
        : problem?.closed ? `Nothing was asked before the run ended, and the problem is ${problem.status}: there is nothing to ask again.`
        : "Nothing was asked before the run ended."}</p>
      <Foot d={d}>{again}</Foot>
    </div>
  );
}

/** A problem's status and project, read from the store: a closed problem has nothing to ask again. */
function useProblemState(caseId: string | null): { status: string; closed: boolean; projectId: string | null; ref: string | null } | null {
  const sig = useInboxStore((s) => { const t = caseId ? (s.tasks as Record<string, { status?: string; project_id?: string | null; short_id?: string }> | undefined)?.[caseId] : null; return t ? `${t.status ?? ""}\u0000${t.project_id ?? ""}\u0000${t.short_id ?? ""}` : null; });
  return useMemo(() => {
    if (!sig) return null;
    const [status, projectId, ref] = sig.split("\u0000");
    return { status, closed: /^(dropped|closed|done|cancell?ed|wontfix)$/.test(status), projectId: projectId || null, ref: ref || null };
  }, [sig]);
}

/** An open row at an agent's or a script's step: the visit as the run page shows it, its one act in its head, then where else to read. */
function Visit({ r, step, model, ws }: { r: WorkRow; step: LineStep; model: LineModel; ws: StepWorkListProps["ws"] }) {
  const d = r.d;
  const projectId = useInboxStore((s) => (d.caseId ? (s.tasks as Record<string, { project_id?: string | null }> | undefined)?.[d.caseId]?.project_id ?? null : null));
  // Start again belongs to a problem's newest visit here, while the problem is open: an older visit was already followed
  // by a newer run, and a closed problem's failure is history (it sits under its own folded heading).
  // A spend cap runs again on its own once its window rolls: starting it now only meets the same cap.
  // Blocked by a bug in a file it runs: the fix is the act, starting again only meets the same bug.
  const fixFile = blockerFile(r.blocked);
  const current = !r.key.startsWith("run:") && !r.problemClosed && !r.movedOn && !r.cause?.key.startsWith("budget:");
  const act = (r.state === "review" || r.state === "unlanded") && d.caseId
    ? <ReviewActs taskId={d.caseId} runId={d.runId} problem={d.caseRef ? `${d.caseRef} · ${d.caseTitle}` : d.caseTitle} />
    : (r.state === "failed" || r.state === "stopped") && d.caseId && current
    // A station that said what blocks it: a new run meets the same block until that clears, so starting is not the lead
    // and its review says the block first.
    ? <>
        {fixFile && <BlockerFix file={fixFile} reason={r.blocked!} step={step.label} problems={blockedProblems([r])} />}
        <StartRunAct icon={<RotateCcw className="w-3.5 h-3.5" aria-hidden />} taskId={d.caseId} problem={d.caseRef ? `${d.caseRef} · ${d.caseTitle}` : d.caseTitle} projectId={projectId}
          {...(r.blocked ? { label: "Start again anyway", primary: false, hold: r.blocked } : {})} />
      </>
    : r.state === "passed" ? <Mark step={step} d={d} /> : null;
  return (
    <>
      <StepVisit model={model} ws={ws} d={d} act={act} mark={r.state === "review" ? "waiting" : undefined} fallback={<div className="sp-detail"><Foot d={d} earlier={r.earlier} again={r.again}>{act}</Foot></div>} />
      {/* The visit above already links its session: the foot links only what it does not. */}
      {model.runs.some((x) => x.id === d.runId) && <div className="sp-detail sp-detail-foot"><Foot d={d} earlier={r.earlier} again={r.again} session={false} /></div>}
    </>
  );
}

/** A fix handed off for review: the review itself (its pull request, through the merge review; pressing lands nothing
 *  until confirmed), and the branch it is on. */
function ReviewActs({ taskId, runId, problem }: { taskId: string; runId: string; problem: string }) {
  const branch = useRunBranch(runId, taskId);
  return (
    <span className="lw-closed-acts" data-line-step-review>
      <MergeFixAct taskId={taskId} problem={problem} change={null} approved={null} />
      {branch && <BranchName name={branch} />}
    </span>
  );
}

/** An open row's foot: its one act, then where else to read (the run, the session, earlier runs of the same problem here). */
function Foot({ d, took, earlier, again, session = true, children }: { d: StepDecision; took?: string | null; earlier?: StepDecision[]; again?: StepDecision[]; session?: boolean; children?: ReactNode }) {
  const nav = useLineNav();
  const [more, setMore] = useState(false);
  // The earlier runs of this problem here, and those this row stands for (it failed the same way before): each its own link.
  const older = [...(again ?? []), ...(earlier ?? [])].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i);
  return (
    <footer className="sp-foot">
      <div className="sp-foot-act">{children}</div>
      <div className="sp-foot-links">
        {took && <span className="sp-quiet lw-num">took {took}</span>}
        <NavLink className="lw-link" href={nav.runHref(d.runId, d.caseId)} onOpen={() => nav.openRun(d.runId, d.caseId)}>Open the run</NavLink>
        {d.caseId && nav.openCase && <NavLink className="lw-link" href={nav.caseHref?.(d.caseId) ?? null} onOpen={() => nav.openCase!(d.caseId!)}>Open the problem</NavLink>}
        {session && d.received.href && <a className="lw-link" href={d.received.href}>Open the session</a>}
        {older.length > 0 && <button type="button" className="lw-link" aria-expanded={more} onClick={() => setMore((v) => !v)}>{older.length} earlier {older.length === 1 ? "run" : "runs"} of this problem</button>}
      </div>
      {more && older.length > 0 && (
        <ul className="sp-earlier">
          {older.map((e) => (
            <li key={e.id}>
              <NavLink className="lw-link" href={nav.runHref(e.runId, e.caseId)} onOpen={() => nav.openRun(e.runId, e.caseId)}>{dayWords(e.at) ?? "Earlier"}</NavLink>
              <span>{plainOutcome(e.status === "failed" && !e.decided.outcome ? "failed" : e.decided.outcome ?? e.decided.toWords ?? e.decided.words)}</span>
            </li>
          ))}
        </ul>
      )}
    </footer>
  );
}

/** Right or wrong on a passed visit, one two-way control: the step's test set, and what an agent asked to change it is shown. */
function Mark({ step, d }: { step: LineStep; d: StepDecision }) {
  const mine = d.labels.find((l) => l.mine) ?? null;
  const [note, setNote] = useState(mine?.note ?? "");
  const label = (verdict: "right" | "wrong" | null, text?: string | null) => { void useInboxStore.getState().labelDecision(d.runId, step.id, verdict, text ?? null); };
  const press = (verdict: "right" | "wrong") => () => label(mine?.verdict === verdict ? null : verdict, verdict === "wrong" ? note || null : null);
  return (
    <span className="sp-mark" data-line-step-mark={mine?.verdict ?? "none"}>
      <span className="lw-seg" role="group" aria-label="Was this right?">
        <button type="button" aria-pressed={mine?.verdict === "right"} onClick={press("right")}>Mark right</button>
        <button type="button" aria-pressed={mine?.verdict === "wrong"} onClick={press("wrong")}>Mark wrong</button>
      </span>
      {mine?.verdict === "wrong" && (
        <input
          className="sp-mark-note"
          value={note}
          placeholder="What should it have concluded?"
          aria-label="What should it have concluded?"
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if ((mine.note ?? "") !== note) label("wrong", note || null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        />
      )}
    </span>
  );
}
