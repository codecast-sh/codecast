"use client";
// One step of a run, opened from the trace (line-workspace.md LW1): what it
// was given (IN), what it did (RAN), and where it sent the run (OUT), each
// as the real thing: the prompt the agent's session was handed, the command
// a script ran and what it printed, the card a person answered; the agent's
// last message and its session; the outcome and the next step. A decision
// can be marked right or wrong here (the step's test set, LW4), and an
// agent step re-run on this case with its prompt as it stands or as edited.
import { useMemo, useState } from "react";
import { ArrowRight, Bot, CornerDownRight, ExternalLink, RotateCcw } from "lucide-react";
import { decisionId, decisionKey, type LineModel, type LineRunModel, type LineVisit } from "../../../../../lib/line/lineModel";
import { runEndTone, runEndWords, stepOutcomes, wrongNote } from "../../../../../lib/line/replay";
import { expandCommand, lastWord, outcomeLabel, readableOutput, readsOf, textHead, tokenWords, toolLog, usdWords, valueFromRendered, type ToolLogRow, type TraceMessage, type TraceStep } from "../../../../../lib/line/runTrace";
import { useStationInput } from "../../../../../hooks/useLineWorkspace";
import { useConversationMessages } from "../../../../../hooks/useConversationMessages";
import { useInboxStore } from "../../../../../store/inboxStore";
import { MarkdownRenderer } from "../../../../tools/MarkdownRenderer";
import { CameBackTag, LINE_ACTIONS, ResultFields, closedTone, durationWords, outcomeTone, outcomeWords } from "../../../widgets";
import { requestDrawerTab, takeMarkRequest, useMarkRequest, useStepDraft } from "../../stepDrafts";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { jsonObject } from "../../../../../lib/line/visitOutput";
import { checkName, checksSummary, errorField, isPathValue, type ReviewVerdict, type ScriptChecks } from "../../../../../lib/line/scriptReport";
import type { RunRetarget } from "../../../../../lib/line/runTrace";
import { useTrialCards, type TrialCardRow } from "../../../../../hooks/useSyncTrial";
import { checkNotRun, honestChecks } from "@codecast/shared/contracts/changeCard";
import { TrialWait } from "../trialCards";
import { trialWords, wouldLabel } from "../../../../../lib/line/fixDecision";


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
  /** What the run's diagnosis re-targeted the problem to (an escalation's kept and evicted counts). */
  retarget?: RunRetarget | null;
  /** People's names by user id, for who answered a card. */
  names?: ReadonlyMap<string, string>;
  /** Open the run's problem, and a trial card in the app. */
  onProblem?: (() => void) | null;
  onCard?: (ref: string) => void;
  /** Open the session decision a trial card is (sd-N), in place. */
  onDecide?: (ref: string) => void;
  /** Evals the run owes and never ran, and its Verify step's report: what the card at a person step is read against. */
  runOwed?: { select: string; files: number } | null;
  runVerify?: ScriptChecks | null;
  /** What the run's landing stations did, for Ship, Merge and Watch. */
  landing?: RunLanding | null;
};

/** A `$step.json.field` the run kept no value for, said as what goes there: "attempt id from Bind". */
export function unsetVarWords(name: string, labelOf?: (id: string) => string | undefined): string {
  const [id, kind, ...path] = name.replace(/^\$/, "").split(".");
  const step = labelOf?.(id) ?? id.replace(/_/g, " ");
  if (kind === "json" && path.length) return `${path.join(" ").replace(/_/g, " ")} from ${step}`;
  if (kind === "output") return `output of ${step}`;
  return id.replace(/_/g, " ");
}

/** A command as it ran (runTrace expandCommand): each value the run put in set apart and shown whole, its name on hover;
 *  a step value the run kept none of reads as what goes there. A long command is clamped as a block, never mid-value. */
function Command({ text, resolve, labelOf, lines = 8 }: { text: string; resolve: (name: string) => string | null; labelOf?: (id: string) => string | undefined; lines?: number }) {
  const [open, setOpen] = useState(false);
  const parts = useMemo(() => expandCommand(text, resolve), [text, resolve]);
  const full = parts.map((p) => (p.unset ? "" : p.text)).join("");
  const long = full.split("\n").length > lines || full.length > lines * 90;
  return (
    <div className="rd-fold" data-open={open ? "" : undefined}>
      <pre className="rd-pre rd-pre-mono rd-cmd" data-clamp={long && !open ? "" : undefined} style={{ ["--rd-clamp" as string]: lines }}>
        {parts.map((p, i) => (!p.name ? p.text
          : p.unset ? <span key={i} className="rd-var" data-unset="" title={`$${p.name}: not kept on this run`}>{unsetVarWords(p.name, labelOf)}</span>
          : <span key={i} className="rd-var" data-filled="" title={`$${p.name}`}>{p.text}</span>))}
      </pre>
      {long && <button type="button" className="rd-more" onClick={() => setOpen((o) => !o)}>{open ? "Show less" : "Show all"}</button>}
    </div>
  );
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
function Fold({ text, lines = 14, as = "text" }: { text: string; lines?: number; as?: "text" | "md" | "code" }) {
  const [open, setOpen] = useState(false);
  const { head, more } = useMemo(() => textHead(text, lines), [text, lines]);
  const shown = open || !more ? text : head;
  return (
    <div className="rd-fold" data-open={open ? "" : undefined}>
      {as === "md" ? <div className="rd-md"><MarkdownRenderer content={shown} /></div>
        : as === "code" ? <pre className="rd-pre rd-pre-mono">{shown}</pre>
        : <pre className="rd-pre">{shown}</pre>}
      {more > 0 && <button type="button" className="rd-more" onClick={() => setOpen((o) => !o)}>{open ? "Show less" : `${more} more lines`}</button>}
    </div>
  );
}

type WroteField = ReturnType<typeof readsOf>[number];

/** What a script wrote, as fields: each one's value (kept by the run, or read back out of the prompt of the step that
 *  read it) and who read it, a chip that opens that step. */
function Wrote({ fields, resolve, run, model, onJump }: { fields: WroteField[]; resolve: (name: string) => string | null; run: LineModel["runs"][number]; model: LineModel; onJump: (i: number) => void }) {
  // Group the fields by the first step that read them on this run with a session to read its prompt from.
  const groups = useMemo(() => {
    const by = new Map<string, { visit: number; session: string | null; fields: WroteField[] }>();
    for (const f of fields) {
      const at = f.byIds.map((id) => run.visits.findIndex((x) => x.node === id && !x.inferred)).find((i) => i >= 0) ?? -1;
      const visit = at >= 0 ? run.visits[at] : null;
      const key = visit ? `${visit.node}:${at}` : "";
      const g = by.get(key) ?? { visit: at, session: visit?.sessionId ?? null, fields: [] };
      g.fields.push(f);
      by.set(key, g);
    }
    return [...by.values()];
  }, [fields, run.visits]);
  if (!fields.length) return null;
  return (
    <dl className="rd-wrote" data-replay-wrote={fields.length}>
      {groups.map((g) => g.session && g.fields.some((f) => resolve(f.name) == null)
        ? <ReaderValues key={`${g.visit}`} group={g} resolve={resolve} run={run} model={model} onJump={onJump} />
        : g.fields.map((f) => <WroteRow key={f.name} f={f} value={resolve(f.name)} run={run} onJump={onJump} />))}
    </dl>
  );
}

/** A reader's prompt, read once, and the values in it of the fields it read. */
function ReaderValues({ group, resolve, run, model, onJump }: { group: { visit: number; session: string | null; fields: WroteField[] }; resolve: (name: string) => string | null; run: LineModel["runs"][number]; model: LineModel; onJump: (i: number) => void }) {
  const brief = useStationInput(group.session, run.id);
  const reader = run.visits[group.visit];
  const template = model.steps[reader?.node ?? ""]?.prompt?.text ?? "";
  const values = group.fields.map((f) => resolve(f.name) ?? (brief?.found && template ? valueFromRendered(template, brief.text, f.name) : null));
  // Not one field anchors in what the reader was handed: this run read an earlier text of its prompt, with other
  // fields. Its values are in that prompt, one click away; the drawn text's field names would be the wrong ones.
  if (brief?.found && values.every((v) => v == null)) {
    const label = model.steps[reader.node]?.label ?? reader.node;
    return (
      <div className="rd-wrote-earlier" data-replay-wrote-earlier="">
        <dt className="rd-dim">{label} read an earlier prompt</dt>
        <dd />
        <dd className="rd-wrote-by"><button type="button" className="rd-chip rd-readby" onClick={() => onJump(group.visit)}>What {label} was given</button></dd>
      </div>
    );
  }
  return (
    <>
      {group.fields.map((f, i) => <WroteRow key={f.name} f={f} value={values[i]} reading={values[i] == null && brief === undefined} run={run} onJump={onJump} />)}
    </>
  );
}

function WroteRow({ f, value, reading, run, onJump }: { f: WroteField; value: string | null; reading?: boolean; run: LineModel["runs"][number]; onJump: (i: number) => void }) {
  return (
    <div>
      <dt className="rd-mono">{f.field}</dt>
      <dd>{value != null ? <FieldValue name={`$${f.name}`} value={value} /> : reading ? <span className="lw-spin" aria-hidden /> : <span className="rd-dim">not kept</span>}</dd>
      <dd className="rd-wrote-by">
        {f.byIds.map((id, j) => {
          const i = run.visits.findIndex((x) => x.node === id && !x.inferred);
          return i >= 0
            ? <button key={id} type="button" className="rd-chip rd-readby" onClick={() => onJump(i)} title={`Read by ${f.by[j]}: open that step`}>{f.by[j]}</button>
            : <span key={id} className="rd-chip rd-readby" data-off="">{f.by[j]}</span>;
        })}
      </dd>
    </div>
  );
}

/** A field's value: a link when it is one, a long one clamped and opened on click. */
function FieldValue({ name, value }: { name: string; value: string }) {
  if (/^https?:\/\/\S+$/.test(value.trim())) return <a className="rd-link rd-mono" href={value.trim()} target="_blank" rel="noreferrer" title={name}>{value.trim()}</a>;
  return <VarValue name={name} value={value} />;
}

/** Keys a script's report carries that the step shows as their own block (checks, errors) or that say nothing (paths, the ok flag). */
const SHOWN_APART = new Set(["steps", "preexisting", "errors", "ok", "logs"]);

/** A script's printed output: a JSON object (whole, or on its first line before a log) reads as its fields (key, value),
 *  checks and errors drawn apart above it, file paths left out; the text itself a toggle away. */
function Output({ text, apart }: { text: string; apart?: boolean }) {
  const [raw, setRaw] = useState(false);
  const fields = useMemo(() => {
    const o = jsonObject(text);
    return o ? Object.entries(o).filter(([k, v]) => !isPathValue(v) && !(apart && SHOWN_APART.has(k))) : null;
  }, [text, apart]);
  if (!fields) return <Fold text={readableOutput(text)} as="code" lines={16} />;
  return (
    <>
      {raw ? <Fold text={readableOutput(text)} as="code" lines={24} /> : fields.length > 0 && (
        <dl className="rd-wrote" data-replay-output-fields={fields.length}>
          {fields.map(([k, v]) => (
            <div key={k}>
              <dt className="rd-mono">{k}</dt>
              <dd>{v == null || v === "" ? <span className="rd-dim">empty</span> : <FieldValue name={k} value={typeof v === "string" ? v : JSON.stringify(v)} />}</dd>
              <dd className="rd-wrote-by" />
            </div>
          ))}
        </dl>
      )}
      <button type="button" className="rd-more" aria-pressed={raw} onClick={() => setRaw((o) => !o)}>{raw ? "Fields" : "Raw"}</button>
    </>
  );
}

/** A check runner's report as a table: a row a check with its dot and its words, the files it passed over as preexisting,
 *  and the one log line that matters. `card` is the check the run's card shows for this step, when it disagrees. */
function ChecksTable({ checks, card }: { checks: ScriptChecks; card?: { detail: string } | null }) {
  return (
    <div className="rd-checks" data-replay-checks={checksSummary(checks).text}>
      {checks.rows.map((r) => {
        const pre = r.ok && checks.preexisting.length > 0 && /typecheck|types?\b|tsc/i.test(r.name);
        return (
          <div key={r.name} className="rd-check" data-ok={r.ok ? "true" : "false"} title={r.name}>
            <span className="rd-check-dot" aria-label={r.ok ? "pass" : "fail"} />
            <span className="rd-check-name">{checkName(r.name)}</span>
            <span className="rd-check-detail">
              {r.detail && !/^passed$/i.test(r.detail) ? r.detail.replace(/^passed:\s*/i, "") : r.ok ? "pass" : "fail"}
              {pre && <span className="rd-chip rd-chip-warn" title={checks.preexisting.join(", ")}>preexisting: {checks.preexisting.join(", ")}</span>}
            </span>
          </div>
        );
      })}
      {card && (
        <div className="rd-check" data-ok="false" data-replay-card-disagrees="">
          <span className="rd-check-dot" aria-label="fail on the card" />
          <span className="rd-check-name">On the card</span>
          <span className="rd-check-detail">Verify red: {card.detail}</span>
        </div>
      )}
      {checks.log && <div className="rd-check-log" title={checks.log}>{checks.log}</div>}
    </div>
  );
}

/** Errors a script reported while exiting 0: one red row each, the field it names set apart. */
function ErrorsList({ errors }: { errors: string[] }) {
  return (
    <ul className="rd-errors" data-replay-errors={errors.length}>
      {errors.map((e) => {
        const m = errorField(e);
        return <li key={e}>{m ? <><b>{m[1]}</b><span>{m[2]}</span></> : e}</li>;
      })}
    </ul>
  );
}

/** A reviewer's verdict: a row a question with pass or fail and its one-line reason. */
function ReviewRows({ review }: { review: ReviewVerdict }) {
  return (
    <div className="rd-checks" data-replay-review={review.verdict}>
      {review.points.map((p) => (
        <div key={p.n} className="rd-check" data-ok={p.ok ? "true" : "false"}>
          <span className="rd-check-dot" aria-label={p.ok ? "pass" : "fail"} />
          <span className="rd-check-name">{p.n}. {p.ok ? "pass" : "fail"}</span>
          <span className="rd-check-detail">{p.why}</span>
        </div>
      ))}
    </div>
  );
}

/** The trial card a person step put in front of its person, for this run and step. */
function useStepCard(runId: string, node: string): TrialCardRow | null {
  const cards = useTrialCards();
  return useMemo(() => cards.find((c) => c.run_id === runId && c.node_id === node) ?? null, [cards, runId, node]);
}

/** The change card as the person reads it: the recommendation, the checks with their dots (and evals the run owes), what is wrong, what changes, the diff. */
function CardBody({ card, owed, verifyRan }: { card: NonNullable<TrialCardRow["card"]>; owed: { select: string; files: number } | null; verifyRan: ScriptChecks | null }) {
  const checks = honestChecks(card.checks);
  const rec = card.recommend?.verdict;
  return (
    <>
      {rec && <span className="rd-recbadge" data-verdict={rec} title={card.recommend.why}>{rec}</span>}
      <div className="rd-checks" data-replay-card-checks={checks.length}>
        {checks.map((c) => {
          const notRun = checkNotRun(c);
          // The card's Verify read off the task's handoff; the run's own Verify step is the record of this run.
          const ran = c.name === "Verify" && verifyRan ? checksSummary(verifyRan) : null;
          return (
            <div key={c.name} className="rd-check" data-ok={notRun ? (owed ? "false" : "true") : c.ok ? "true" : "false"} data-owed={notRun && owed ? "" : undefined}>
              <span className="rd-check-dot" aria-label={c.ok ? "pass" : "fail"} />
              <span className="rd-check-name">{c.name}</span>
              <span className="rd-check-detail">
                {notRun && owed ? `${owed.select} evals owed, ${owed.files} ${owed.files === 1 ? "file" : "files"}, not run` : c.detail.replace(/^handoff status (\w+)$/, "handoff marked $1")}
                {ran && ran.bad !== !c.ok && <span className="rd-chip" data-tone={ran.bad ? "bad" : undefined} title="What this run's Verify step reported">this run: {ran.text}</span>}
              </span>
            </div>
          );
        })}
        {owed && !checks.some((c) => checkNotRun(c)) && (
          <div className="rd-check" data-ok="false" data-owed="">
            <span className="rd-check-dot" aria-label="owed" />
            <span className="rd-check-name">Eval</span>
            <span className="rd-check-detail">{owed.select} evals owed, {owed.files} {owed.files === 1 ? "file" : "files"}, not run</span>
          </div>
        )}
      </div>
      <dl className="rd-cardf">
        {card.wrong && <><dt>wrong</dt><dd>{card.wrong}</dd></>}
        {card.change && <><dt>change</dt><dd>{card.change}</dd></>}
        {card.diff && <><dt>diff</dt><dd className="rd-mono">{card.diff.files} files <span className="lw-plus-n">+{card.diff.added}</span> <span className="lw-minus-n">−{card.diff.removed}</span></dd></>}
      </dl>
    </>
  );
}

/** A step the drawn graph does not have (an end an older graph named, "escalated_at_refine"): what it means for the run, from what the run recorded. */
/** What a run's landing stations did, read once for the run (runReport landingStep), with the merge its history recorded. */
export type RunLanding = { result: string; note: string | null; state: string; merge: { sha: string; branch: string; into: string; prUrl: string | null } | null; end: string };

/** A landing station (Ship, Merge, Watch) as its own IN, RAN and OUT: what it was handed, whether the change landed and why not, the commit or PR. */
function LandingStep({ v, t, landing, onJump }: { v: LineVisit; t: TraceStep; landing: RunLanding; onJump: (i: number) => void }) {
  const notLanded = landing.state !== "done";
  return (
    <div className="rd-step" data-replay-step={v.node} data-kind="end" data-replay-landing="">
      <header className="rd-step-head">
        <span className="rd-step-n">{t.n}</span>
        <div className="rd-step-title">
          <h2>{v.label}</h2>
          <div className="rd-step-facts"><span className="rd-kind" data-kind="end">landing</span>{v.durationMs != null && <span className="rd-num">{durationWords(v.durationMs)}</span>}</div>
        </div>
      </header>
      <div className="rd-io" data-io="in">
        <span className="rd-tag">In</span>
        <div className="rd-io-body">
          {landing.merge
            ? <div className="rd-io-meta"><span>branch</span><span className="rd-mono">{landing.merge.branch}</span><ArrowRight className="w-3 h-3" aria-hidden /><span className="rd-mono">{landing.merge.into}</span></div>
            : <div className="rd-io-meta"><span>branch</span><span className="rd-dim">no merge recorded</span></div>}
          {v.received.from && (
            <div className="rd-from">
              <CornerDownRight className="w-3 h-3" aria-hidden />
              <span>from</span>
              <button type="button" className="rd-link" onClick={() => onJump(v.index - 1)}>{v.received.fromLabel}</button>
            </div>
          )}
        </div>
      </div>
      <div className="rd-io" data-io="ran">
        <span className="rd-tag">Ran</span>
        <div className="rd-io-body">
          <div className="rd-io-meta">
            <span data-tone={notLanded ? "warn" : undefined}>{notLanded ? "not landed" : "landed"}</span>
            {landing.merge && <span className="rd-mono" title={landing.merge.sha}>{landing.merge.sha.slice(0, 7)}</span>}
            {landing.merge?.prUrl && <a className="rd-link" href={landing.merge.prUrl} target="_blank" rel="noreferrer">PR <ExternalLink className="w-3 h-3" aria-hidden /></a>}
          </div>
          <div className="rd-answer" data-tone={notLanded ? "warn" : undefined} data-replay-landing-result="">{landing.result}</div>
        </div>
      </div>
      <div className="rd-io" data-io="out">
        <span className="rd-tag">Out</span>
        <div className="rd-io-body">
          <div className="rd-out">
            <span className="rd-oc rd-oc-big" data-tone={runEndTone(landing.end)}>{landing.end}</span>
            {t.next && (
              <>
                <ArrowRight className="w-3.5 h-3.5 rd-arrow" aria-hidden />
                <button type="button" className="rd-next" onClick={() => onJump(t.next!.i)} data-replay-next>
                  <span className="rd-n">{String(t.next.i + 1).padStart(t.n.length, "0")}</span>{t.next.label}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const LANDING = new Set(["ship", "merge", "watch", "rebase"]);

function OffGraphStep({ v, t, retarget, onProblem }: { v: LineVisit; t: TraceStep; retarget: RunRetarget | null; onProblem: (() => void) | null }) {
  const escalated = /^escalated_at_/.test(v.node);
  const split = escalated && retarget?.refine === "wrong_cause" && (retarget.evicted ?? 0) > 0;
  const kept = retarget?.kept ?? 0;
  const evicted = retarget?.evicted ?? 0;
  const total = kept + evicted;
  return (
    <div className="rd-step" data-replay-step={v.node} data-kind="end">
      <header className="rd-step-head">
        <span className="rd-step-n">{t.n}</span>
        <div className="rd-step-title">
          <h2>{split ? "Escalated: cluster needs a split" : v.label}</h2>
          <div className="rd-step-facts"><span className="rd-kind" data-kind="end">{escalated ? "escalated" : "end"}</span>{split && retarget?.cause && <span className="rd-mono">{retarget.cause}</span>}</div>
        </div>
        {onProblem && <div className="rd-actions"><button type="button" className="lw-act" data-primary="" onClick={onProblem}>Open the problem</button></div>}
      </header>
      {escalated && total > 0 && (
        <div className="rd-io" data-io="in">
          <span className="rd-tag">In</span>
          <div className="rd-io-body">
            <div className="rd-io-meta"><span>refine</span><span>{kept} kept</span><span data-tone="bad">{evicted} evicted</span><span>of {total}</span></div>
            <div className="rd-splitbar" aria-label={`${kept} kept, ${evicted} evicted`}><i style={{ flex: kept }} /><i data-evicted="" style={{ flex: evicted }} /></div>
            {retarget?.evidence && <p className="rd-pre">{retarget.evidence}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Who answered a card: a person by name, or an agent standing in for one (its session, then whom it stood in for). */
function Answerer({ answer, names }: { answer: NonNullable<TrialCardRow["answer"]>; names?: ReadonlyMap<string, string> }) {
  const who = names?.get(answer.by) ?? "someone";
  const at = <span className="rd-dim">{new Date(answer.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>;
  if (answer.stand_in) {
    const by = standInRef(answer.note);
    return (
      <span className="rd-who" data-replay-answerer="" data-stand-in="">
        <i aria-hidden data-agent=""><Bot className="w-3 h-3" /></i>
        agent stand-in{by ? <> <a className="rd-link rd-mono" href={by.href} target="_blank" rel="noreferrer">{by.ref}</a></> : null} for {who}
        {at}
      </span>
    );
  }
  return (
    <span className="rd-who" data-replay-answerer="">
      <i aria-hidden>{who.slice(0, 1).toUpperCase()}</i>
      {who}
      {at}
    </span>
  );
}

/** What a stand-in's note names as the agent that answered: its session ("jx7ab12"), else its task ("ct-59220"). */
export function standInRef(note: string | null | undefined): { ref: string; href: string } | null {
  const session = /\bjx[0-9a-z]{5,}\b/.exec(note ?? "")?.[0];
  if (session) return { ref: session, href: `/conversation/${session}` };
  const task = /\bct-\d+\b/.exec(note ?? "")?.[0];
  return task ? { ref: task, href: `/tasks/${task}` } : null;
}

function Missing({ children, tone }: { children: React.ReactNode; tone?: "bad" }) {
  return <span className="rd-missing" data-tone={tone}>{children}</span>;
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
        {pre ? "Hide the harness preamble" : (() => { const n = preamble.split("\n").length; return `Harness preamble, ${n} ${n === 1 ? "line" : "lines"}`; })()}
      </button>
      {pre && <pre className="rd-pre rd-pre-dim">{preamble}</pre>}
      <Fold text={text.slice(at)} />
    </>
  );
}

/** RAN for an agent: its last message (what it concluded) on top, loaded only for the step open, then its tool calls
 *  in order, a click away, and the session's size and a way in. */
function AgentRan({ t, verdict }: { t: TraceStep; verdict?: boolean }) {
  const id = t.session!.id;
  const { conversation } = useConversationMessages(id);
  const messages = (conversation?.messages ?? []) as unknown as TraceMessage[];
  const word = useMemo(() => lastWord(messages), [messages]);
  const log = useMemo(() => toolLog(messages), [messages]);
  const [showLog, setShowLog] = useState(false);
  const total = t.session!.messages ?? (conversation?.message_count as number | undefined) ?? null;
  const partial = total != null && messages.length < total;
  const loading = !conversation;
  const text = word.text ?? t.output ?? t.pinned;
  return (
    <>
      <div className="rd-io-meta">
        <span>{word.text ? "last message" : t.output ? "concluded" : t.pinned ? "pinned" : "session"}</span>
        {total != null && <span>{total} msgs</span>}
        {log.length > 0 && <button type="button" className="rd-link" aria-expanded={showLog} onClick={() => setShowLog((o) => !o)} data-replay-tools={log.length}>{log.length}{partial ? "+" : ""} tool calls</button>}
        {t.tokens ? <span>{tokenWords(t.tokens)} tok</span> : null}
        {t.costUsd ? <span>{usdWords(t.costUsd)}</span> : null}
        {t.session!.killed && t.status === "failed" && <span data-tone="bad">killed</span>}
        <span className="rd-spacer" />
        <a className="rd-link" href={`/conversation/${id}`} target="_blank" rel="noreferrer">{t.session!.short ?? "Session"} <ExternalLink className="w-3 h-3" aria-hidden /></a>
      </div>
      {text ? <Fold text={text} lines={16} as="md" /> : loading ? <Missing><span className="lw-spin" aria-hidden /> Reading</Missing> : verdict ? null : <Missing tone="bad">It said nothing</Missing>}
      {showLog && <ToolLog rows={log} partial={partial} href={`/conversation/${id}`} />}
    </>
  );
}

const LOG_HEAD = 10;

/** An agent's tool calls, one row each: the tool, what it acted on, how it came back. Ten, the rest a click away. */
function ToolLog({ rows, partial, href }: { rows: ToolLogRow[]; partial: boolean; href: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, LOG_HEAD);
  return (
    <div className="rd-tools" data-replay-toollog={rows.length}>
      {partial && <a className="rd-tools-earlier" href={href} target="_blank" rel="noreferrer">Earlier calls in the session</a>}
      <ol className="rd-tools-list">
        {shown.map((r, i) => (
          <li key={r.id || i} data-status={r.status}>
            <span className="rd-tools-n rd-num">{i + 1}</span>
            <span className="rd-tools-tool">{r.tool}</span>
            <span className="rd-tools-target rd-mono" title={r.target}>{r.target}</span>
            <span className="rd-tools-st" aria-label={r.status}>{r.status === "error" ? "error" : r.status === "open" ? "" : "ok"}</span>
          </li>
        ))}
      </ol>
      {rows.length > LOG_HEAD && <button type="button" className="rd-more" onClick={() => setAll((o) => !o)}>{all ? "Show less" : `Show all ${rows.length}`}</button>}
    </div>
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

export function ReplayStep({ model, run, visit: v, trace: t, openStep, onJump, resolve, rerunning, setRerunning, retarget = null, names, onProblem = null, onCard, onDecide, runOwed = null, runVerify = null, landing = null }: ReplayStepProps) {
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
  const cards = useTrialCards();
  const stepCard = useMemo(() => cards.find((c) => c.run_id === run.id && c.node_id === v.node) ?? null, [cards, run.id, v.node]);
  // A trial run's card asks what the person would do and ships nothing: the step shows the card's own question and
  // options in those words (fixDecision trialWords), never the gate's "Ship this change?".
  const asked = useMemo(() => (stepCard ? trialWords({ question: stepCard.question, options: stepCard.options.map((o) => ({ label: o.label })) }) : null), [stepCard]);
  // The change card this run put in front of its person: its Verify check is set against this step's own report.
  const runCard = useMemo(() => cards.find((c) => c.run_id === run.id && !!c.card) ?? null, [cards, run.id]);
  if (landing && LANDING.has(v.node) && (!step || step.kind === "end")) return <LandingStep v={v} t={t} landing={landing} onJump={onJump} />;
  if (!step) return <OffGraphStep v={v} t={t} retarget={retarget} onProblem={onProblem} />;
  const cardVerify = t.checks && runCard?.card ? honestChecks(runCard.card.checks).find((c) => c.name === "Verify") ?? null : null;
  const cardDisagrees = cardVerify && !cardVerify.ok && !checksSummary(t.checks!).bad ? { detail: cardVerify.detail.replace(/^handoff status (\w+)$/, "handoff marked $1") } : null;

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
  const wrote = k === "script" && !t.output && !scriptResult ? readsOf(model, v.node) : [];
  const scriptBare = (k === "script" || k === "end") && !t.output && !scriptResult && !wrote.length && !t.failReason && v.status !== "live";
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
        <div className="rd-actions" data-quiet={!run.live && !marking && !suspect && !rerunning ? "" : undefined}>
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
                  {t.command ? <Command text={t.command} resolve={resolve} labelOf={(id) => model.steps[id]?.label} /> : <Missing>{k === "end" ? "Nothing runs" : "No command in the graph"}</Missing>}
                </>
              )}
              {k === "person" && (
                <>
                  <div className="rd-io-meta">
                    <span>card</span>
                    {stepCard ? <TrialWait card={stepCard} graph={model.graphKey} onOpen={onCard} onDecide={onDecide} settled={!!stepCard.answer || !run.live} />
                      : t.gate?.ref && <a className="rd-link rd-mono" href={`/decisions/${t.gate.ref}`}>{t.gate.ref}</a>}
                  </div>
                  {stepCard?.card && <CardBody card={stepCard.card} owed={runOwed} verifyRan={runVerify} />}
                  {asked?.question ? <p className="rd-question" data-replay-question data-trial="">{asked.question}</p>
                    : t.gate?.question ? <p className="rd-question" data-replay-question>{t.gate.question}</p> : !step.prompt?.text && <Missing>No card text recorded</Missing>}
                  {asked?.options.length ? (
                    <div className="rd-choices">{asked.options.map((o, i) => <span key={i} className="rd-chip" data-on={stepCard?.answer && wouldLabel(stepCard.answer.label) === o.label ? "" : undefined}>{o.label.replace(/^\[[^\]]*\]\s*/, "")}</span>)}</div>
                  ) : !!t.gate?.choices.length && (
                    <div className="rd-choices">{t.gate.choices.map((c) => <span key={c} className="rd-chip" data-on={t.gate?.answer === c ? "" : undefined}>{c}</span>)}</div>
                  )}
                  {step.prompt?.text && (t.gate?.question
                    ? <details className="rd-report"><summary>Template</summary><Fold text={step.prompt.text} as="code" lines={8} /></details>
                    : <Fold text={step.prompt.text} as="code" lines={8} />)}
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
              {k === "agent" && t.review && <ReviewRows review={t.review} />}
              {k === "agent" && (t.session ? <AgentRan t={t} verdict={!!t.review} /> : t.output || t.pinned ? <Fold text={(t.output ?? t.pinned)!} as="md" /> : <Missing>No session recorded</Missing>)}
              {(k === "script" || k === "end") && (
                <>
                  <div className="rd-io-meta">
                    {(t.output || scriptResult) && <span>{t.output ? "stdout" : "result"}</span>}
                    <span data-tone={v.status === "failed" ? "bad" : undefined}>{v.status === "failed" ? "failed" : v.status === "live" ? "running" : "exit 0"}</span>
                    {t.errors.length > 0 && <span data-tone="bad">{t.errors.length} {t.errors.length === 1 ? "error" : "errors"} reported</span>}
                    {t.checks && <span data-tone={checksSummary(t.checks).bad ? "bad" : undefined}>{checksSummary(t.checks).text}</span>}
                    {took && <span>{took}</span>}
                    {t.costUsd ? <span>{usdWords(t.costUsd)}</span> : null}
                  </div>
                  {t.errors.length > 0 && <ErrorsList errors={t.errors} />}
                  {t.checks && <ChecksTable checks={t.checks} card={cardDisagrees} />}
                  {t.output ? <Output text={t.output} apart />
                    : scriptResult ? <ResultFields result={scriptResult} />
                    : v.status === "failed" ? <Missing>No output recorded</Missing>
                    : <Wrote fields={wrote} resolve={resolve} run={run} model={model} onJump={onJump} />}
                </>
              )}
              {k === "person" && (() => {
                // Only a recorded answer is an answer: a card withdrawn or timed out sent the run on unanswered.
                const answer = t.gate?.answer ?? (v.status === "done" && !t.unanswered ? v.decided.toWords ?? outcomeWords(v.decided.outcome, v.status) : null);
                return (
                  <>
                    <div className="rd-io-meta">
                      {t.unanswered
                        ? <span className="rd-dim" data-replay-unanswered="">no answer, timed out{took ? ` ${took}` : ""}</span>
                        : <span>{v.status === "waiting" ? "waiting" : answer ? "answered" : "no answer"}</span>}
                      {!t.unanswered && took && v.durationMs != null && v.durationMs > 60_000 && <span>{answer ? "after" : "open"} {took}</span>}
                    </div>
                    {answer && stepCard?.answer && <Answerer answer={stepCard.answer} names={names} />}
                    {answer ? <div className="rd-answer">{stepCard?.answer ? wouldLabel(stepCard.answer.label) : answer}</div> : t.unanswered ? null : <Missing>{v.status === "waiting" ? "No answer yet" : t.gist ?? "Nobody answered"}</Missing>}
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
            {(() => {
              const said = k === "end" ? step.label.toLowerCase() : t.inferred ? "earlier round" : outcomeLabel(t);
              return said ? <span className="rd-oc rd-oc-big" data-tone={k === "end" ? runEndTone(runEndWords(run)) : t.unanswered ? "none" : tone}>{said}</span> : null;
            })()}
            <CameBackTag closed={decision?.closed} />
            {t.owed && <span className="rd-oc rd-oc-big" data-tone="bad" data-replay-owed="">Evals owed: {t.owed.select}, {t.owed.files} {t.owed.files === 1 ? "file" : "files"}, not run</span>}
            {t.next ? (
              <>
                <ArrowRight className="w-3.5 h-3.5 rd-arrow" aria-hidden />
                <button type="button" className="rd-next" onClick={() => onJump(t.next!.i)} data-replay-next>
                  <span className="rd-n">{String(t.next.i + 1).padStart(t.n.length, "0")}</span>{t.next.label}
                </button>
                {t.next.when && !t.unanswered && ![outcomeLabel(t), t.next.label, t.gate?.answer ?? ""].some((w) => w.toLowerCase() === t.next!.when!.toLowerCase()) && <span className="rd-when">{t.next.when}</span>}
              </>
            ) : run.live ? <span className="lw-dot" data-pulse="" style={{ color: "var(--lw-live)" }} aria-hidden /> : null}
            {/* A person's step lists its options above: their one-letter keys are not paths a reader can name. */}
            {k !== "person" && otherOutcomes.length > 0 && outcomes.length > 1 && (
              <span className="rd-could" title="The graph's other ways out of this step, not taken on this run"><span className="rd-could-k">other paths</span>{otherOutcomes.map((o) => {
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
