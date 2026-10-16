"use client";
// One step of a run, selected in its trace (line-journeys.md LJ8.4), shown as
// the real thing by who did it:
//   an agent   what it concluded (its last message), its tool calls, what it
//              was told (folded), its session
//   a person   the thing that waits (WaitingItem), or the decision as it was
//              answered, with who and when
//   a script   the command as it ran and what it printed
//   parked     the reason in full, and the question to answer when one is asked
//   landing    the commit or pull request, and whether production has it
// A step holds at most one act, chosen by how the run stands (RunPage passes
// it in); "Open the step" is a link to the step's own page.
import { useMemo, useState, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Bot } from "lucide-react";
import type { LineModel, LineRunModel, LineVisit } from "../../../../../lib/line/lineModel";
import type { LineNeed } from "../../../../../lib/line/lineNeeds";
import { spanShort, type StepMark } from "../../../../../lib/line/runPage";
import { expandCommand, lastWord, outcomeLabel, readableOutput, textHead, toolLog, type ToolLogRow, type TraceMessage, type TraceStep } from "../../../../../lib/line/runTrace";
import { checkName, checksSummary, errorField, isPathValue, type ReviewVerdict, type ScriptChecks } from "../../../../../lib/line/scriptReport";
import { jsonObject } from "../../../../../lib/line/visitOutput";
import { wouldLabel } from "../../../../../lib/line/fixDecision";
import { useStationInput } from "../../../../../hooks/useLineWorkspace";
import { useConversationMessages } from "../../../../../hooks/useConversationMessages";
import type { TrialCardRow } from "../../../../../hooks/useSyncTrial";
import { MarkdownRenderer } from "../../../../tools/MarkdownRenderer";
import { LineDecision } from "../../../widgets/LineDecision";
import { WaitingItem } from "../../../widgets/WaitingItem";

/** Where a run's fix is: its merge (the commit or pull request) and whether a production deploy carried it. */
export type RunLanding = {
  merge: { sha: string; branch: string; into: string; at: number; prUrl: string | null } | null;
  /** When production got it; null when it has not, or when that is not known. */
  liveAt: number | null;
  /** What codecast knows of the project's deploys: recorded and none carried it, none recorded at all, or not read yet. */
  coverage: "known" | "none" | "unread";
  /** The newest production deploy on record, for a fix it did not carry. */
  lastDeploy: { at: number; href: string | null } | null;
};

export type RunStepProps = {
  model: LineModel;
  run: LineRunModel;
  visit: LineVisit;
  trace: TraceStep;
  mark: StepMark;
  onJump: (index: number) => void;
  /** A `$name`'s value on this run (runTrace varValue), null when the run kept none. */
  resolve: (name: string) => string | null;
  /** What waits on a person at this step, when something does: the reader that answers it. */
  need?: LineNeed | null;
  /** The decision this step asked (sd-N), when it is not the open need: shown as it was answered or left. */
  decisionRef?: string | null;
  /** The trial card a person step put in front of its person, for who answered and what. */
  card?: TrialCardRow | null;
  names?: ReadonlyMap<string, string>;
  /** The step's one act (Start again), when the run's state calls for one here. */
  act?: ReactNode;
  /** The step's own page, as a link. */
  stepHref?: string | null;
  onOpenStep?: () => void;
  onProblem?: (taskId: string) => void;
  onRun?: (runId: string, taskId: string | null) => void;
  /** Why the problem was parked, whole (the task's note), for a Park step with no question to answer. */
  parkedNote?: string | null;
  landing?: RunLanding | null;
  /** The engine's own reason for the run's stop, behind a disclosure on the step it stopped at. */
  engineReason?: string | null;
  /** The run ended at its fix decision and nobody answered it: the dock the problem page shows under it (ClosedDecisionDock),
   *  so the decision reads closed and its acts (Ask again, Drop) are here too. */
  unanswered?: ReactNode;
};

const dayTime = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const day = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** A block of text shown by its head, the rest one click away, never cut mid-line. */
function Fold({ text, lines = 40, as = "text" }: { text: string; lines?: number; as?: "text" | "md" | "code" }) {
  const [open, setOpen] = useState(false);
  const { head, more } = useMemo(() => textHead(text, lines, lines * 160), [text, lines]);
  const shown = open || !more ? text : head;
  return (
    <div className="rp-fold">
      {as === "md" ? <div className="rp-md"><MarkdownRenderer content={shown} /></div>
        : <pre className={as === "code" ? "rp-pre rp-pre-mono" : "rp-pre"}>{shown}</pre>}
      {more > 0 && <button type="button" className="lw-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Show less" : `Show all, ${more} more lines`}</button>}
    </div>
  );
}

/** A named part of a step: a quiet heading and its content. */
function Part({ name, children, aside, id }: { name: string; children: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <section className="rp-part" data-run-part={id ?? name.toLowerCase().replace(/\W+/g, "-")}>
      <h3 className="rp-h"><span>{name}</span>{aside}</h3>
      {children}
    </section>
  );
}

/** A part folded shut until asked for. */
function Disclosure({ name, children, count, id }: { name: string; children: ReactNode; count?: number | string; id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rp-part" data-run-part={id} data-open={open ? "" : undefined}>
      <button type="button" className="rp-h rp-h-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="lw-chev" aria-hidden /><span>{name}</span>{count != null && <span className="lw-num rp-h-n">{count}</span>}
      </button>
      {open && children}
    </section>
  );
}

/** A `$step.json.field` the run kept no value for, said as what goes there: "attempt id from Bind". */
export function unsetVarWords(name: string, labelOf?: (id: string) => string | undefined): string {
  const [id, kind, ...path] = name.replace(/^\$/, "").split(".");
  const step = labelOf?.(id) ?? id.replace(/_/g, " ");
  if (kind === "json" && path.length) return `${path.join(" ").replace(/_/g, " ")} from ${step}`;
  if (kind === "output") return `output of ${step}`;
  return id.replace(/_/g, " ");
}

/** A command as it ran (runTrace expandCommand): every value the run put in set apart, its name on hover. */
function Command({ text, resolve, labelOf }: { text: string; resolve: (name: string) => string | null; labelOf?: (id: string) => string | undefined }) {
  const parts = useMemo(() => expandCommand(text, resolve), [text, resolve]);
  return (
    <pre className="rp-pre rp-pre-mono rp-cmd" data-run-command>
      {parts.map((p, i) => (!p.name ? p.text
        : p.unset ? <span key={i} className="rp-var" data-unset="" title={`$${p.name}: not kept on this run`}>{unsetVarWords(p.name, labelOf)}</span>
        : <span key={i} className="rp-var" title={`$${p.name}`}>{p.text}</span>))}
    </pre>
  );
}

/** Keys a script's report carries that the step shows as their own block (checks, errors) or that say nothing (the ok flag, log paths). */
const SHOWN_APART = new Set(["steps", "preexisting", "errors", "ok", "logs"]);
const fieldWords = (k: string) => { const w = k.replace(/_/g, " "); return w.charAt(0).toUpperCase() + w.slice(1); };

/** What a script printed. A JSON report reads as its fields in words, machine paths left out; anything else as printed. */
function Output({ text }: { text: string }) {
  const fields = useMemo(() => {
    const o = jsonObject(text);
    return o ? Object.entries(o).filter(([k, v]) => !isPathValue(v) && !SHOWN_APART.has(k) && v != null && v !== "") : null;
  }, [text]);
  if (!fields) return <Fold text={readableOutput(text)} as="code" />;
  if (!fields.length) return null;
  return (
    <dl className="rp-facts" data-run-output-fields={fields.length}>
      {fields.map(([k, v]) => {
        const value = typeof v === "string" ? v : typeof v === "boolean" ? (v ? "yes" : "no") : JSON.stringify(v);
        return <div key={k}><dt>{fieldWords(k)}</dt><dd>{/^https?:\/\/\S+$/.test(value.trim()) ? <a className="lw-link" href={value.trim()} target="_blank" rel="noreferrer">{value.trim()}</a> : value}</dd></div>;
      })}
    </dl>
  );
}

/** A check runner's report: one row a check with its mark, what it said, and the one log line that matters. */
function Checks({ checks }: { checks: ScriptChecks }) {
  return (
    <div className="rp-checks" data-run-checks={checksSummary(checks).text}>
      {checks.rows.map((r) => (
        <div key={r.name} className="rp-check" data-ok={r.ok ? "true" : "false"}>
          <span className="rp-mark" data-mark={r.ok ? "done" : "failed"} role="img" aria-label={r.ok ? "passed" : "failed"} />
          <span className="rp-check-name">{checkName(r.name)}</span>
          <span className="rp-check-detail">{r.detail && !/^passed$/i.test(r.detail) ? r.detail.replace(/^passed:\s*/i, "") : r.ok ? "passed" : "failed"}</span>
        </div>
      ))}
      {checks.preexisting.length > 0 && <p className="rp-note">Failing outside this change: {checks.preexisting.join(", ")}</p>}
      {checks.log && <pre className="rp-pre rp-pre-mono">{checks.log}</pre>}
    </div>
  );
}

/** A reviewer's verdict: a row a question with pass or fail and its reason. */
function Review({ review }: { review: ReviewVerdict }) {
  return (
    <div className="rp-checks" data-run-review={review.verdict}>
      {review.points.map((p) => (
        <div key={p.n} className="rp-check" data-ok={p.ok ? "true" : "false"}>
          <span className="rp-mark" data-mark={p.ok ? "done" : "failed"} role="img" aria-label={p.ok ? "passed" : "failed"} />
          <span className="rp-check-name">{p.n}</span>
          <span className="rp-check-detail">{p.why}</span>
        </div>
      ))}
    </div>
  );
}

/** Where the part of a prompt about this problem starts: its Goal or Task heading, after the harness's preamble. */
export function briefStart(text: string): number {
  const m = /^#{1,3}[ \t]*(Goal|Task|The problem|Problem)\b/im.exec(text);
  return m && m.index > 0 ? m.index : 0;
}

/** What an agent was told: the first message its session was given, opening on the part about this problem. */
function Told({ sessionId, runId }: { sessionId: string; runId: string }) {
  const brief = useStationInput(sessionId, runId);
  if (brief === undefined) return <p className="rp-note"><span className="lw-spin" aria-hidden /> Reading</p>;
  if (!brief?.found) return <p className="rp-note">Its session cannot be read from here. <a className="lw-link" href={`/conversation/${sessionId}`} target="_blank" rel="noreferrer">Open the session</a></p>;
  return <Fold text={brief.text.slice(briefStart(brief.text))} lines={60} />;
}

const LOG_HEAD = 12;

/** An agent's tool calls, one row each: the tool, what it acted on, how it came back. */
function ToolCalls({ rows, partial, href }: { rows: ToolLogRow[]; partial: boolean; href: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, LOG_HEAD);
  return (
    <div className="rp-tools" data-run-toollog={rows.length}>
      {partial && <a className="lw-link" href={href} target="_blank" rel="noreferrer">Earlier calls are in the session</a>}
      <ol>
        {shown.map((r, i) => (
          <li key={r.id || i} data-status={r.status}>
            <span className="rp-tools-tool">{r.tool}</span>
            <span className="rp-tools-target">{r.target}</span>
            {r.status === "error" && <span className="rp-tools-err">error</span>}
          </li>
        ))}
      </ol>
      {rows.length > LOG_HEAD && <button type="button" className="lw-link" onClick={() => setAll((o) => !o)}>{all ? "Show less" : `Show all ${rows.length}`}</button>}
    </div>
  );
}

/** An agent step with a session: what it concluded, its tool calls, what it was told. */
function AgentSession({ t, runId }: { t: TraceStep; runId: string }) {
  const id = t.session!.id;
  const { conversation } = useConversationMessages(id);
  const messages = (conversation?.messages ?? []) as unknown as TraceMessage[];
  const word = useMemo(() => lastWord(messages), [messages]);
  const log = useMemo(() => toolLog(messages), [messages]);
  const total = t.session!.messages ?? (conversation?.message_count as number | undefined) ?? null;
  const partial = total != null && messages.length < total;
  const text = word.text ?? t.output ?? t.pinned;
  const href = `/conversation/${id}`;
  const sessionLink = <a className="lw-link rp-h-link" href={href} target="_blank" rel="noreferrer" data-run-session={id}>Open the session<ArrowUpRight className="w-3 h-3" aria-hidden /></a>;
  // A session that handed the problem back ended on what it wrote there (the evidence, what it tried, what it needs):
  // that is its conclusion, whole. Its last chat line only introduces it ("Handing off as blocked with the evidence:").
  if (t.handoff?.note) {
    return (
      <>
        <Part name={t.handoff.status === "blocked" ? "Handed back blocked" : "Handed back asking for context"} id="concluded" aside={sessionLink}>
          <Fold text={t.handoff.note} as="md" lines={80} />
        </Part>
        {log.length > 0 && <Disclosure name="Tool calls" count={`${log.length}${partial ? "+" : ""}`} id="tools"><ToolCalls rows={log} partial={partial} href={href} /></Disclosure>}
        <Disclosure name="What it was told" id="told"><Told sessionId={id} runId={runId} /></Disclosure>
      </>
    );
  }
  return (
    <>
      {/* A session that went quiet without a report concluded nothing: what it said last is where it was. */}
      <Part name={t.quiet ? "Its last words" : "Concluded"} id="concluded" aside={sessionLink}>
        {t.review && <Review review={t.review} />}
        {text ? <Fold text={text} as="md" />
          : !conversation ? <p className="rp-note"><span className="lw-spin" aria-hidden /> Reading</p>
          : t.review ? null
          : <p className="rp-note" data-tone="bad">It ended without saying anything{t.session!.killed ? ": its session was stopped" : ""}.</p>}
      </Part>
      {log.length > 0 && <Disclosure name="Tool calls" count={`${log.length}${partial ? "+" : ""}`} id="tools"><ToolCalls rows={log} partial={partial} href={href} /></Disclosure>}
      <Disclosure name="What it was told" id="told"><Told sessionId={id} runId={runId} /></Disclosure>
    </>
  );
}

/** What a stand-in's note names as the agent that answered: its session ("jx7ab12"), else its task ("ct-59220"). */
export function standInRef(note: string | null | undefined): { ref: string; href: string } | null {
  const session = /\bjx[0-9a-z]{5,}\b/.exec(note ?? "")?.[0];
  if (session) return { ref: session, href: `/conversation/${session}` };
  const task = /\bct-\d+\b/.exec(note ?? "")?.[0];
  return task ? { ref: task, href: `/tasks/${task}` } : null;
}

/** A person step with no decision record to embed: what was asked, and what was answered, by whom and when. */
function PersonRecord({ t, v, card, names }: { t: TraceStep; v: LineVisit; card: TrialCardRow | null; names?: ReadonlyMap<string, string> }) {
  const question = card?.question ?? t.gate?.question ?? null;
  const answer = t.unanswered ? null : card?.answer ? wouldLabel(card.answer.label) : t.gate?.answer ?? (v.status === "done" ? v.decided.toWords ?? null : null);
  const note = t.gate?.note ?? v.why ?? null;
  const by = card?.answer ? standInRef(card.answer.stand_in ? card.answer.note : null) : null;
  return (
    <>
      {question && <Part name="Asked" id="asked"><p className="rp-question" data-run-question>{question}</p></Part>}
      <Part name="Answer" id="answer">
        {answer ? (
          <dl className="rp-facts" data-run-answer>
            <div><dt>Answered</dt><dd>{answer}</dd></div>
            {card?.answer && (
              <div>
                <dt>By</dt>
                <dd>{card.answer.stand_in
                  ? <><Bot className="w-3.5 h-3.5 inline" aria-hidden /> an agent{by ? <> (<a className="lw-link" href={by.href} target="_blank" rel="noreferrer">{by.ref}</a>)</> : null} for {names?.get(card.answer.by) ?? "someone"}</>
                  : names?.get(card.answer.by) ?? "someone"}, {dayTime(card.answer.at)}</dd>
              </div>
            )}
            {note && <div><dt>Note</dt><dd>{note}</dd></div>}
          </dl>
        ) : <p className="rp-note" data-run-unanswered>{t.unanswered ? `Nobody answered${spanShort(v.durationMs) ? ` in ${spanShort(v.durationMs)}` : ""}, and the run went on without an answer.` : v.status === "waiting" || v.status === "live" ? "Not answered yet." : "Nobody answered."}</p>}
      </Part>
    </>
  );
}

/** Where a fix is: merged (its commit or pull request) and whether production has it. The same facts a problem's page shows. */
function Landing({ landing }: { landing: RunLanding }) {
  const m = landing.merge;
  return (
    <Part name="Where the fix is" id="landing">
      <dl className="rp-facts" data-run-landing={landing.liveAt ? "production" : m ? "merged" : "built"}>
        <div>
          <dt>Merged</dt>
          <dd>{m ? <>{day(m.at)}{m.into ? ` into ${m.into}` : ""} · {m.prUrl
            ? <a className="lw-link" href={m.prUrl} target="_blank" rel="noreferrer">Pull request<ArrowUpRight className="w-3 h-3 inline" aria-hidden /></a>
            : <span className="rp-mono" title={m.sha}>{m.sha.slice(0, 7)}</span>}</> : "No merge recorded"}</dd>
        </div>
        <div>
          <dt>In production</dt>
          <dd>{landing.liveAt ? day(landing.liveAt) : landing.coverage === "none" ? "Not recorded for this project" : landing.coverage === "unread" ? "Reading the deploys" : "No"}</dd>
        </div>
        {!landing.liveAt && landing.coverage === "known" && landing.lastDeploy && (
          <div><dt>Last production deploy</dt><dd>{landing.lastDeploy.href ? <a className="lw-link" href={landing.lastDeploy.href} target="_blank" rel="noreferrer">{day(landing.lastDeploy.at)}</a> : day(landing.lastDeploy.at)}</dd></div>
        )}
        {m && <div><dt>Branch</dt><dd className="rp-mono">{m.branch}</dd></div>}
      </dl>
    </Part>
  );
}

const LANDING_STEPS = new Set(["ship", "merge", "watch", "rebase"]);

export function RunStep({ model, run, visit: v, trace: t, mark, onJump, resolve, need = null, decisionRef = null, card = null, names, act, stepHref, onOpenStep, onProblem, onRun, parkedNote = null, landing = null, engineReason = null, unanswered = null }: RunStepProps) {
  const step = model.steps[v.node] ?? null;
  const k = step?.kind ?? v.kind;
  const took = spanShort(v.durationMs);
  const parked = /(^|_)park($|_)/.test(v.node);
  const person = k === "person" || (!!need && !parked);
  const onGraph = !!step && step.kind !== "end";
  // What it decided, in its own word; the engine's bare success or failure is already the step's mark.
  const decided = t.inferred ? "" : outcomeLabel(t);
  const said = decided && !/^(success|failure|failed|waiting|running)$/i.test(decided) ? decided : null;
  const newest = v.inferred ? run.visits.reduce((j, x, i) => (x.node === v.node && !x.inferred ? i : j), -1) : -1;
  const showLanding = landing && (LANDING_STEPS.has(v.node) || (step?.stage === "build" && k === "agent"));
  // A reader that fills its box (WaitingItem, the decision): the step gives it the rest of the page, with no scroll of its own around it.
  const boxed = !v.inferred && (!!need || (!parked && person && !!decisionRef));
  const scriptResult = (k === "script" || k === "end") && !t.output && v.decided.result && Object.keys(v.decided.result).length ? JSON.stringify(v.decided.result) : null;

  return (
    <article className="rp-step" data-run-open-step={v.node} data-kind={k} data-mark={mark} data-need={need?.kind} data-boxed={boxed ? "" : undefined}>
      <header className="rp-step-head">
        <div className="rp-step-title">
          <h2>{step?.label ?? v.label}</h2>
          <p className="rp-step-meta">
            <span className="rp-mark" data-mark={mark} aria-hidden />
            <span data-run-step-state>{mark === "failed" ? "Failed" : mark === "waiting" ? "Waiting on a person" : mark === "live" ? "Running" : mark === "skipped" ? (t.notRun ? "Did not run" : t.unanswered ? "No answer" : "No record") : "Done"}</span>
            {took && mark !== "waiting" && mark !== "live" && <span className="lw-num">{took}</span>}
            {v.at != null && <time dateTime={new Date(v.at).toISOString()}>{dayTime(v.at)}</time>}
            {t.rounds != null && <span>{t.rounds} tries</span>}
          </p>
        </div>
        <div className="rp-step-acts">
          {onGraph && stepHref && <a className="lw-link" href={stepHref} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0 || !onOpenStep) return; e.preventDefault(); onOpenStep(); }} data-run-open-step-page>Open the step</a>}
          {act}
        </div>
      </header>

      {v.inferred ? (
        <Part name="An earlier try" id="earlier">
          <p className="rp-note">The run went through this step more than once and keeps only the newest try.</p>
          {newest >= 0 && <button type="button" className="lw-act" onClick={() => onJump(newest)}>Go to the newest try</button>}
        </Part>
      ) : need ? (
        // The thing that waits, read and answered here (the same reader For you and the problem page mount).
        <div className="rp-need" data-run-need={need.ref}>
          <WaitingItem need={need} evidence={false} onProblem={onProblem} onRun={onRun} head={false} runShown={run.id} />
        </div>
      ) : parked ? (
        <Part name="Why it is parked" id="parked">
          {parkedNote ? <p className="rp-question" data-run-parked>{parkedNote}</p> : <p className="rp-note">The run recorded no reason.</p>}
        </Part>
      ) : person && decisionRef && unanswered ? (
        // Nobody answered it: read only, with the acts that still move the problem docked under it, as on the problem page.
        <div className="rp-need lwn" data-headless="" data-line-need="lapsed" data-run-decision={decisionRef}>
          <div className="lwn-thing"><LineDecision key={decisionRef} id={decisionRef} onProblem={onProblem} onRun={onRun} head={false} act={false} /></div>
          {unanswered}
        </div>
      ) : person && decisionRef ? (
        // The decision as it was answered or left, whole: its own page marks the answer, who gave it and when.
        <div className="rp-need" data-run-decision={decisionRef}>
          <LineDecision key={decisionRef} id={decisionRef} onProblem={onProblem} onRun={onRun} head={false} />
        </div>
      ) : person ? (
        <PersonRecord t={t} v={v} card={card} names={names} />
      ) : t.notRun ? (
        // A landing step the runner closed because nobody approved the change: why it did not run, and nothing it printed.
        <>
          <Part name="Why it did not run" id="not-run"><p className="rp-question" data-run-not-run>Nothing landed: {t.notRun} before anyone answered it.</p></Part>
          {t.command && <Disclosure name="What it would have run" id="ran"><Command text={t.command} resolve={resolve} labelOf={(id) => model.steps[id]?.label} /></Disclosure>}
        </>
      ) : k === "agent" ? (
        t.session ? <AgentSession t={t} runId={run.id} />
          : <Part name="Concluded" id="concluded">{t.review && <Review review={t.review} />}{t.output || t.pinned ? <Fold text={(t.output ?? t.pinned)!} as="md" /> : <p className="rp-note" data-run-no-session>{mark === "failed" ? "It never started: no session was opened for this step." : "No session was recorded for this step."}</p>}</Part>
      ) : (
        <>
          {t.command && <Part name="Ran" id="ran"><Command text={t.command} resolve={resolve} labelOf={(id) => model.steps[id]?.label} /></Part>}
          {(t.errors.length > 0 || t.checks || t.output || scriptResult || mark === "failed") && (
            <Part name="Output" id="output">
              {t.errors.length > 0 && <ul className="rp-errors" data-run-errors={t.errors.length}>{t.errors.map((e) => { const m = errorField(e); return <li key={e}>{m ? <><b>{m[1]}</b> {m[2]}</> : e}</li>; })}</ul>}
              {t.checks && <Checks checks={t.checks} />}
              {t.output ? <Output text={t.output} /> : scriptResult ? <Output text={scriptResult} /> : mark === "failed" && !t.checks && !t.errors.length ? <p className="rp-note">It printed nothing.</p> : null}
            </Part>
          )}
          {t.command && step?.prompt?.text && step.prompt.text.trim() !== t.command.trim() && <Disclosure name="Template" id="template"><pre className="rp-pre rp-pre-mono">{step.prompt.text}</pre></Disclosure>}
        </>
      )}

      {/* A hand-back's note, shown whole above under a heading that says how it ended, is why it failed. */}
      {t.failReason && !need && !(t.handoff?.note && t.session && k === "agent") && <Part name="Why it failed" id="failed"><p className="rp-fail" data-run-fail>{t.failReason}</p></Part>}
      {showLanding && <Landing landing={landing!} />}
      {engineReason && <Disclosure name="The engine's own reason" id="engine"><pre className="rp-pre rp-pre-mono">{engineReason}</pre></Disclosure>}

      {!boxed && (said || t.next) && (
        <footer className="rp-then" data-run-then>
          <span className="rp-then-k">{said ? "Decided" : "Then"}</span>
          {said && <span className="rp-then-said" data-mark={mark}>{said}</span>}
          {t.next && (
            <button type="button" className="rp-next" onClick={() => onJump(t.next!.i)} data-run-next={t.next.node}>
              <ArrowRight className="w-3.5 h-3.5" aria-hidden />{t.next.label}
            </button>
          )}
        </footer>
      )}
    </article>
  );
}
