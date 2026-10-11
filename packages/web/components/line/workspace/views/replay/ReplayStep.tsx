"use client";
// One step of a run, opened from the trace (line-workspace.md LW1): what it
// was given (IN), what it did (RAN), and where it sent the run (OUT), each
// as the real thing: the prompt the agent's session was handed, the command
// a script ran and what it printed, the card a person answered; the agent's
// last message and its session; the outcome and the next step. A decision
// can be marked right or wrong here (the step's test set, LW4), and an
// agent step re-run on this case with its prompt as it stands or as edited.
import { useMemo, useState } from "react";
import { ArrowRight, CornerDownRight, ExternalLink, RotateCcw } from "lucide-react";
import { decisionId, decisionKey, type LineModel, type LineRunModel, type LineVisit } from "../../../../../lib/line/lineModel";
import { runEndTone, runEndWords, stepOutcomes, wrongNote } from "../../../../../lib/line/replay";
import { lastWord, outcomeLabel, readableOutput, textHead, tokenWords, usdWords, type TraceStep } from "../../../../../lib/line/runTrace";
import { useStationInput } from "../../../../../hooks/useLineWorkspace";
import { useConversationMessages } from "../../../../../hooks/useConversationMessages";
import { useInboxStore } from "../../../../../store/inboxStore";
import { MarkdownRenderer } from "../../../../tools/MarkdownRenderer";
import { CameBackTag, LINE_ACTIONS, ResultFields, closedTone, durationWords, outcomeTone, outcomeWords } from "../../../widgets";
import { requestDrawerTab, takeMarkRequest, useMarkRequest, useStepDraft } from "../../stepDrafts";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";


const KIND_WORD = { agent: "agent", script: "script", person: "person", end: "end" } as const;

export type ReplayStepProps = {
  model: LineModel;
  run: LineRunModel;
  visit: LineVisit;
  trace: TraceStep;
  /** Open a step in the drawer (the workspace selection). */
  openStep: (stepId: string) => void;
  onJump: (index: number) => void;
  /** A `$name`'s value on this run (runTrace varValue), null when the run kept none. */
  resolve: (name: string) => string | null;
  /** The case is being re-run from this step. */
  rerunning: boolean;
  setRerunning: (on: boolean) => void;
};

/** A `$step.json.field` the run kept no value for, said as what goes there: "attempt id from Bind". */
export function unsetVarWords(name: string, labelOf?: (id: string) => string | undefined): string {
  const [id, kind, ...path] = name.replace(/^\$/, "").split(".");
  const step = labelOf?.(id) ?? id.replace(/_/g, " ");
  if (kind === "json" && path.length) return `${path.join(" ").replace(/_/g, " ")} from ${step}`;
  if (kind === "output") return `output of ${step}`;
  return id.replace(/_/g, " ");
}

/** Inserted values in a command: each `$name` shown as the value it ran with, its name on hover; one the run kept no value for reads as what goes there. */
function withVars(text: string, resolve?: (name: string) => string | null, labelOf?: (id: string) => string | undefined) {
  return text.split(/(\$[a-zA-Z_][\w.]*)/g).map((p, i) => {
    if (!(i % 2)) return p;
    const value = resolve?.(p.slice(1)) ?? null;
    // A bare `$name` the run did not fill is the script's own shell variable, not an input: it reads as written.
    if (value == null && !p.includes(".")) return p;
    return value != null
      ? <VarValue key={i} name={p} value={value} />
      : <span key={i} className="rd-var" data-unset="" title={`${p}: not kept on this run`}>{unsetVarWords(p, labelOf)}</span>;
  });
}

const VAR_HEAD = 160;

/** One inserted value: a long one shows its head, and a click shows it whole. */
function VarValue({ name, value }: { name: string; value: string }) {
  const [open, setOpen] = useState(false);
  if (value.length <= VAR_HEAD) return <span className="rd-var" data-filled="" title={name}>{value}</span>;
  return (
    <button type="button" className="rd-var" data-filled="" data-long="" aria-expanded={open} title={open ? `${name}: click to shorten` : `${name}: ${value.length} characters, click to read it whole`} onClick={() => setOpen((o) => !o)}>
      {open ? value : `${value.slice(0, VAR_HEAD)}…`}
    </button>
  );
}

/** A block of text shown by its head, the rest a click away: prose, markdown, or code with its inserted values set apart. */
function Fold({ text, lines = 14, as = "text", resolve, labelOf }: { text: string; lines?: number; as?: "text" | "md" | "code"; resolve?: (name: string) => string | null; labelOf?: (id: string) => string | undefined }) {
  const [open, setOpen] = useState(false);
  const { head, more } = useMemo(() => textHead(text, lines), [text, lines]);
  const shown = open || !more ? text : head;
  return (
    <div className="rd-fold" data-open={open ? "" : undefined}>
      {as === "md" ? <div className="rd-md"><MarkdownRenderer content={shown} /></div>
        : as === "code" ? <pre className="rd-pre rd-pre-mono">{withVars(shown, resolve, labelOf)}</pre>
        : <pre className="rd-pre">{shown}</pre>}
      {more > 0 && <button type="button" className="rd-more" onClick={() => setOpen((o) => !o)}>{open ? "Show less" : `${more} more lines`}</button>}
    </div>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <span className="rd-missing">{children}</span>;
}

/** IN for an agent: the first message its session was given, which is the rendered prompt. */
function AgentIn({ t, runId, model, openStep }: { t: TraceStep; runId: string; model: LineModel; openStep: (id: string) => void }) {
  const brief = useStationInput(t.session?.id ?? null, runId);
  const step = model.steps[t.node];
  const file = step?.prompt?.file?.split("/").pop() ?? null;
  const readPrompt = () => { requestDrawerTab(t.node, "prompt"); openStep(t.node); };
  return (
    <>
      <div className="rd-io-meta">
        <span>prompt</span>
        {file && <button type="button" className="rd-link rd-mono" onClick={readPrompt} title="The template in the graph">{file}</button>}
        {step?.prompt?.version && <span className="rd-mono">{step.prompt.version.hash.slice(0, 6)}</span>}
        {brief?.found && <span>{brief.text.split("\n").length} lines{brief.truncated ? "+" : ""}</span>}
      </div>
      {!t.session ? <Missing>No session recorded</Missing>
        : brief === undefined ? <Missing><span className="lw-spin" aria-hidden /> Reading</Missing>
        : !brief?.found ? (step?.prompt?.text ? <><Missing>Session not readable here; the template:</Missing><Fold text={step.prompt.text} as="code" /></> : <Missing>Session not readable here</Missing>)
        : <Brief text={brief.text} />}
    </>
  );
}

/** Where the part of a prompt about this problem starts: its Goal or Task heading, after the harness's preamble. */
export function briefStart(text: string): number {
  const m = /^#{1,3}[ \t]*(Goal|Task|The problem|Problem)\b/im.exec(text);
  return m && m.index > 0 ? m.index : 0;
}

/** An agent's prompt, opening on the part about this problem; the harness preamble before it folded to one line. */
function Brief({ text }: { text: string }) {
  const [pre, setPre] = useState(false);
  const at = briefStart(text);
  if (!at) return <Fold text={text} />;
  const preamble = text.slice(0, at).replace(/\s+$/, "");
  return (
    <>
      <button type="button" className="rd-more rd-preamble" aria-expanded={pre} onClick={() => setPre((o) => !o)}>
        {pre ? "Hide the harness preamble" : `Harness preamble, ${preamble.split("\n").length} lines`}
      </button>
      {pre && <pre className="rd-pre rd-pre-dim">{preamble}</pre>}
      <Fold text={text.slice(at)} />
    </>
  );
}

/** RAN for an agent: its last message, loaded only for the step open, with the session's size and a way in. */
function AgentRan({ t }: { t: TraceStep }) {
  const id = t.session!.id;
  const { conversation } = useConversationMessages(id);
  const messages = (conversation?.messages ?? []) as Array<{ role: string; content?: string; tool_calls?: unknown[]; timestamp?: number }>;
  const word = useMemo(() => lastWord(messages), [messages]);
  const total = t.session!.messages ?? (conversation?.message_count as number | undefined) ?? null;
  const partial = total != null && messages.length < total;
  const loading = !conversation;
  const text = word.text ?? t.output ?? t.pinned;
  return (
    <>
      <div className="rd-io-meta">
        <span>{word.text ? "last message" : t.output ? "concluded" : t.pinned ? "pinned" : "session"}</span>
        {total != null && <span>{total} msgs</span>}
        {messages.length > 0 && <span>{word.tools}{partial ? "+" : ""} tools</span>}
        {t.tokens ? <span>{tokenWords(t.tokens)} tok</span> : null}
        {t.costUsd ? <span>{usdWords(t.costUsd)}</span> : null}
        {t.session!.killed && t.status === "failed" && <span data-tone="bad">killed</span>}
        <span className="rd-spacer" />
        <a className="rd-link" href={`/conversation/${id}`} target="_blank" rel="noreferrer">{t.session!.short ?? "Session"} <ExternalLink className="w-3 h-3" aria-hidden /></a>
      </div>
      {text ? <Fold text={text} lines={16} as="md" /> : loading ? <Missing><span className="lw-spin" aria-hidden /> Reading</Missing> : <Missing>It said nothing</Missing>}
    </>
  );
}

function MarkBox({ outcomes, current, onCancel, onSave }: { outcomes: string[]; current: string | null; onCancel: () => void; onSave: (should: string | null, why: string) => void }) {
  const [pick, setPick] = useState<string | null>(null);
  const [why, setWhy] = useState("");
  const others = outcomes.filter((o) => o !== current);
  return (
    <div className="rd-markbox" data-replay-markbox>
      <div className="rd-io-meta"><span>should have decided</span></div>
      <div className="rd-opts">
        {others.map((o) => <button key={o} type="button" className="rd-chip" aria-pressed={pick === o} onClick={() => setPick(o)}>{outcomeWords(o)}</button>)}
        {current && <button type="button" className="rd-chip" aria-pressed={pick === current} onClick={() => setPick(current)}>{outcomeWords(current)}, wrong reason</button>}
      </div>
      <textarea className="rd-note" value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why (optional)" rows={2} autoFocus={!others.length} />
      <div className="rd-actions">
        <button type="button" className="lw-act" onClick={onCancel}>Cancel</button>
        <button type="button" className="lw-act" data-primary="" disabled={!pick && !why.trim()} onClick={() => onSave(pick === current ? null : pick, pick === current && !why.trim() ? "Right outcome, wrong reason." : why)}>Add to test set</button>
      </div>
    </div>
  );
}

export function ReplayStep({ model, run, visit: v, trace: t, openStep, onJump, resolve, rerunning, setRerunning }: ReplayStepProps) {
  const step = model.steps[v.node];
  const [marking, setMarking] = useState(false);
  // The Timeline asked to mark this decision wrong (a close that did not hold): open the box, once.
  const markAsk = useMarkRequest();
  useWatchEffect(() => {
    if (!markAsk || markAsk.run !== run.id || markAsk.step !== v.node) return;
    takeMarkRequest(markAsk.n);
    if (markAsk.mark) setMarking(true);
  }, [markAsk, run.id, v.node]);
  const decision = useMemo(() => step?.decisions.find((d) => d.id === decisionId(run.id, v.node)) ?? null, [step, run.id, v.node]);
  const outcomes = useMemo(() => (step ? stepOutcomes(model, step) : []), [model, step]);
  const draft = useStepDraft(v.node);
  if (!step) return <div className="lw-empty"><b>{v.label}</b>Not in the graph drawn here</div>;

  const k = step.kind;
  const Try = LINE_ACTIONS.Try;
  const label = decision?.label ?? null;
  const took = durationWords(v.durationMs);
  const cutOff = !v.inferred && decisionKey(v) === "cut off";
  const canLabel = !v.inferred && !cutOff && (k === "agent" || k === "person") && v.status !== "live" && v.status !== "waiting";
  const suspect = !!decision?.closed && !decision.closed.held;
  const label_ = (verdict: "right" | "wrong" | null, note?: string) => useInboxStore.getState().labelDecision(run.id, v.node, verdict, note ?? null);
  const canRerun = !!Try && k === "agent" && !!step.prompt && step.prompt.kind === "prompt" && !v.inferred && v.status !== "live";
  const edited = draft != null && draft !== step.prompt?.text;
  const newest = v.inferred ? run.visits.reduce((j, x, i) => (x.node === v.node && !x.inferred ? i : j), -1) : -1;
  const otherOutcomes = outcomes.filter((o) => o !== v.decided.outcome);
  /** The step an outcome would have sent the run to, from the branch that tests for it. */
  const exitTo = (o: string) => {
    const e = model.graph.edges.find((x) => x.from === v.node && !!x.condition && new RegExp(`\\boutcome\\s*={1,2}\\s*["']?${o.replace(/[^\w-]/g, "")}\\b`).test(x.condition));
    return e ? model.steps[e.to]?.label ?? model.graph.nodes.find((n) => n.id === e.to)?.label ?? null : null;
  };
  const tone = closedTone(decision?.closed) ?? outcomeTone(v.decided.outcome ?? (v.status === "failed" ? "failed" : null), v.status);
  const scriptResult = k === "script" && v.decided.result && Object.keys(v.decided.result).length ? v.decided.result : null;
  // A script that kept nothing to show: RAN is one line (its exit and time), not a section.
  const scriptBare = (k === "script" || k === "end") && !t.output && !scriptResult && !t.failReason && v.status !== "live";
  const reportFields = k !== "script" && v.decided.result && Object.keys(v.decided.result).some((f) => f !== "outcome" && f !== "summary") ? v.decided.result : null;

  return (
    <div className="rd-step" data-replay-step={v.node} data-kind={KIND_WORD[k]}>
      <header className="rd-step-head">
        <span className="rd-step-n">{t.n}</span>
        <div className="rd-step-title">
          <h2>{step.label}</h2>
          <div className="rd-step-facts">
            <span className="rd-kind" data-kind={KIND_WORD[k]}>{KIND_WORD[k]}</span>
            {k === "agent" && step.model && <span className="rd-mono">{step.model}</span>}
            {took && v.status !== "waiting" && <span className="rd-num">{took}</span>}
            {v.at != null && <span className="rd-num">{new Date(v.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
            {label && <span className="lw-labelmark" data-verdict={label.verdict} title={label.note ?? undefined}>{label.verdict === "wrong" ? "marked wrong" : "marked right"}{label.byName && !label.mine ? ` by ${label.byName}` : ""}</span>}
            {edited && <span className="rd-edited">prompt edited</span>}
          </div>
        </div>
        <div className="rd-actions">
          {canLabel && !label && suspect && <span className="rd-suspect" title={decision!.closed!.words ?? undefined}>came back</span>}
          {canLabel && !label && <button type="button" className="lw-act" onClick={() => label_("right")}>Right</button>}
          {canLabel && !label && <button type="button" className="lw-act rd-wrongbtn" aria-pressed={marking} data-suggest={suspect ? "" : undefined} onClick={() => setMarking((m) => !m)} data-replay-mark>Wrong</button>}
          {label?.mine && <button type="button" className="lw-act" onClick={() => label_(null)}>Unmark</button>}
          {k === "agent" && step.prompt?.kind === "prompt" && <button type="button" className="lw-act" onClick={() => { requestDrawerTab(step.id, "prompt", { edit: true }); openStep(step.id); }}>{draft != null ? "Your edit" : "Edit prompt"}</button>}
          {canRerun && !rerunning && <button type="button" className="lw-act" onClick={() => setRerunning(true)} data-replay-rerun><RotateCcw className="w-3.5 h-3.5" />Re-run</button>}
        </div>
      </header>

      {marking && !label && (
        <MarkBox outcomes={outcomes} current={v.decided.outcome} onCancel={() => setMarking(false)} onSave={(should, note) => { label_("wrong", wrongNote(should, note)); setMarking(false); }} />
      )}
      {label?.note && <div className="rd-labelnote" data-verdict={label.verdict}>{label.note}</div>}

      {v.inferred ? (
        <div className="rd-io">
          <span className="rd-tag">Note</span>
          <div className="rd-io-body">
            <Missing>Earlier round of a loop; the run keeps only the newest visit</Missing>
            {newest >= 0 && <button type="button" className="rd-link" onClick={() => onJump(newest)}>Go to the newest</button>}
          </div>
        </div>
      ) : (
        <>
          <div className="rd-io" data-io="in">
            <span className="rd-tag">In</span>
            <div className="rd-io-body">
              {k === "agent" && <AgentIn t={t} runId={run.id} model={model} openStep={openStep} />}
              {(k === "script" || k === "end") && (
                <>
                  <div className="rd-io-meta">
                    <span>{k === "end" ? "end" : "command"}</span>
                    {step.prompt?.file && <span className="rd-mono">{step.prompt.file.split("/").pop()}</span>}
                  </div>
                  {t.command ? <Fold text={t.command} as="code" lines={8} resolve={resolve} labelOf={(id) => model.steps[id]?.label} /> : <Missing>{k === "end" ? "Nothing runs" : "No command in the graph"}</Missing>}
                </>
              )}
              {k === "person" && (
                <>
                  <div className="rd-io-meta">
                    <span>card</span>
                    {step.prompt?.text && <span>template</span>}
                    {t.gate?.ref && <a className="rd-link rd-mono" href={`/decisions/${t.gate.ref}`}>{t.gate.ref}</a>}
                    {t.gate?.choices.map((c) => <span key={c} className="rd-chip" data-on={t.gate?.answer === c ? "" : undefined}>{c}</span>)}
                  </div>
                  {step.prompt?.text ? <Fold text={step.prompt.text} as="code" lines={8} /> : <Missing>No card text recorded</Missing>}
                </>
              )}
              {v.received.from && (
                <div className="rd-from">
                  <CornerDownRight className="w-3 h-3" aria-hidden />
                  <span>from</span>
                  <button type="button" className="rd-link" onClick={() => onJump(v.index - 1)}>{v.received.fromLabel}</button>
                </div>
              )}
            </div>
          </div>

          <div className="rd-io" data-io="ran" data-empty={scriptBare ? "" : undefined}>
            <span className="rd-tag">Ran</span>
            <div className="rd-io-body">
              {k === "agent" && (t.session ? <AgentRan t={t} /> : t.output || t.pinned ? <Fold text={(t.output ?? t.pinned)!} as="md" /> : <Missing>No session recorded</Missing>)}
              {(k === "script" || k === "end") && (
                <>
                  <div className="rd-io-meta">
                    {(t.output || scriptResult) && <span>{t.output ? "stdout" : "result"}</span>}
                    <span data-tone={v.status === "failed" ? "bad" : undefined}>{v.status === "failed" ? "failed" : v.status === "live" ? "running" : "exit 0"}</span>
                    {took && <span>{took}</span>}
                    {t.costUsd ? <span>{usdWords(t.costUsd)}</span> : null}
                    {scriptBare && <span className="rd-dim">no output kept</span>}
                  </div>
                  {t.output ? <Fold text={readableOutput(t.output)} as="code" lines={16} />
                    : scriptResult ? <ResultFields result={scriptResult} /> : null}
                </>
              )}
              {k === "person" && (() => {
                // Only a recorded answer is an answer: a card withdrawn or timed out sent the run on unanswered.
                const answer = t.gate?.answer ?? (v.status === "done" ? v.decided.toWords ?? outcomeWords(v.decided.outcome, v.status) : null);
                return (
                  <>
                    <div className="rd-io-meta">
                      <span>{v.status === "waiting" ? "waiting" : answer ? "answered" : "no answer"}</span>
                      {took && v.durationMs != null && v.durationMs > 60_000 && <span>{answer ? "after" : "open"} {took}</span>}
                    </div>
                    {answer ? <div className="rd-answer">{answer}</div> : <Missing>{v.status === "waiting" ? "No answer yet" : t.gist ?? "Nobody answered"}</Missing>}
                    {(t.gate?.note || v.why) && <p className="rd-pre">{t.gate?.note ?? v.why}</p>}
                  </>
                );
              })()}
              {t.failReason && <div className="rd-fail">{t.failReason}</div>}
              {reportFields && <details className="rd-report"><summary>Report fields</summary><ResultFields result={reportFields} /></details>}
            </div>
          </div>
        </>
      )}

      <div className="rd-io" data-io="out">
        <span className="rd-tag">Out</span>
        <div className="rd-io-body">
          <div className="rd-out">
            <span className="rd-oc rd-oc-big" data-tone={k === "end" ? runEndTone(runEndWords(run)) : tone}>{k === "end" ? step.label.toLowerCase() : outcomeLabel(t) || "earlier round"}</span>
            <CameBackTag closed={decision?.closed} />
            {t.next ? (
              <>
                <ArrowRight className="w-3.5 h-3.5 rd-arrow" aria-hidden />
                <button type="button" className="rd-next" onClick={() => onJump(t.next!.i)} data-replay-next>
                  <span className="rd-n">{String(t.next.i + 1).padStart(t.n.length, "0")}</span>{t.next.label}
                </button>
                {t.next.when && t.next.when.toLowerCase() !== outcomeLabel(t).toLowerCase() && <span className="rd-when">{t.next.when}</span>}
              </>
            ) : run.live ? <span className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-hidden /> : null}
            {otherOutcomes.length > 0 && outcomes.length > 1 && (
              <span className="rd-could" title="The graph's other ways out of this step, not taken on this run">{otherOutcomes.map((o) => {
                const to = exitTo(o);
                return <span key={o} className="rd-alt">{outcomeWords(o)}{to && <><ArrowRight className="w-3 h-3" aria-hidden />{to}</>}</span>;
              })}</span>
            )}
          </div>
        </div>
      </div>

      {rerunning && Try && (
        <div className="rd-io" data-io="rerun" data-replay-after>
          <span className="rd-tag">Re-run</span>
          <div className="rd-io-body">
            <div className="rd-io-meta">
              <span>{edited ? "with your edit" : "prompt as it stands"}</span>
              <span className="rd-spacer" />
              <button type="button" className="rd-link" onClick={() => setRerunning(false)}>Close</button>
            </div>
            <Try model={model} step={step} draft={edited ? draft : null} runs={[run.id]} />
          </div>
        </div>
      )}
    </div>
  );
}
