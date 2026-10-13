"use client";
// The act band of a problem's page (line-journeys.md LJ8.3): always drawn,
// and in exactly one state. It never restates the stage track's line; it
// holds the thing (what waits on a person, through the one reader), fact rows,
// and at most one act. Where nothing is owed it says so with facts alone.
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { useInboxStore } from "../../../../../store/inboxStore";
import type { LineNeed } from "../../../../../lib/line/lineNeeds";
import type { LineAdmission } from "../../../../../lib/lineFlow";
import { dayTimeWords, dayWords, spanShort, type ProblemBand as Band } from "../../../../../lib/line/problemPage";
import { aboutWords, useRunDuration } from "../../../../../lib/line/runDuration";
import { LineDecision } from "../../../widgets/LineDecision";
import { ClosedDecisionDock } from "../../../widgets/ClosedDecisionActs";
import { StartRunAct } from "../../../widgets/StartRunAct";
import { WaitingItem } from "../../../widgets/WaitingItem";
import { ProblemAsk } from "./AskBlock";
import { MergeFixAct } from "./MergeFixAct";
import { LineStartControl } from "../../../../consequential/lineStart";
import { lineSettingsHref } from "../../../../../lib/lineSettings";

export type ProblemBandProps = {
  band: Band;
  need: LineNeed | null;
  taskId: string;
  taskRef: string | null;
  title: string;
  projectId: string | null;
  projectTitle: string | null;
  admission: LineAdmission | null;
  /** The problem has a goal and nobody is assigned: an answer lets the sweep start it. */
  startable: boolean;
  askFocus: boolean;
  now: number;
  onProblem: (taskId: string) => void;
  onRun: (runId: string, taskId: string | null) => void;
  onStep: (runId: string, step: string | null) => void;
  /** Where the project's start control lives: Problems, Not started, this project. */
  notStartedHref: string;
  onNotStarted: () => void;
};

const Fact = ({ k, children, tone }: { k: string; children: ReactNode; tone?: "bad" | "warn" | "ok" }) => (
  <div className="pb-fact" data-tone={tone}><dt>{k}</dt><dd>{children}</dd></div>
);
const Out = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="lw-link pb-out" href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight className="w-3 h-3" aria-hidden /></a>
);

export function ProblemBand(p: ProblemBandProps) {
  const { band: b } = p;
  const ms = useRunDuration(p.projectId);
  const problem = p.taskRef ? `${p.taskRef} · ${p.title}` : p.title;
  // The role that owns the project's line, from the org on hand: its merge step and its page.
  const roleId = p.admission?.role?.id ?? null;
  const mergeRole = useInboxStore((s) => {
    const r = roleId ? s.orgTree?.roles.find((x) => x._id === roleId) : null;
    return r ? `${(r as { line_merge?: boolean }).line_merge ? 1 : 0}|${r.short_id ?? r.handle}` : null;
  });
  const merge = mergeRole ? { on: mergeRole.startsWith("1"), ref: mergeRole.slice(2) } : null;

  if (b.kind === "need" && p.need) {
    // A decision is a full pane with its answers docked at its foot: it gets a box of fixed height (LJ6.2 host contract).
    const boxed = b.need === "decision" || b.need === "lapsed" || b.need === "reask";
    return (
      <section className="pb pb-need" data-line-band={b.need} data-boxed={boxed ? "" : undefined} aria-label="What waits on you">
        <WaitingItem need={p.need} evidence={false} onProblem={p.onProblem} onRun={p.onRun} head={false} now={p.now} />
      </section>
    );
  }
  if (b.kind === "decision") {
    return (
      <section className="pb pb-need" data-line-band="decision" data-boxed="" aria-label="The decision on this problem">
        <LineDecision key={b.ref} id={b.ref} onProblem={p.onProblem} onRun={p.onRun} head={false} />
      </section>
    );
  }
  if (b.kind === "unanswered") {
    // The fix decision as it was asked, read only, and the acts that still move the problem: the same reader and acts a
    // lapsed need shows in For you and the Decide step (ClosedDecisionActs).
    return (
      <section className="pb pb-need" data-line-band="unanswered" data-boxed="" aria-label="The fix nobody answered">
        <div className="lwn" data-headless="" data-line-need="lapsed">
          <div className="lwn-thing">
            {b.ref ? <LineDecision key={b.ref} id={b.ref} onProblem={p.onProblem} onRun={p.onRun} head={false} act={false} /> : <p className="pb-reason">The run ended before its decision reached anyone.</p>}
          </div>
          <ClosedDecisionDock decisionRef={b.ref} state={b.withdrawn ? "withdrawn" : "lapsed"} taskId={p.taskId} taskRef={p.taskRef} title={p.title} projectId={p.projectId} runId={b.runId} askedAt={b.askedAt} built={b.built} onRun={(id) => p.onRun(id, p.taskId)} />
        </div>
      </section>
    );
  }
  if (b.kind === "need" && !p.need && b.need === "reask") {
    // A run paused for an answer nobody was asked: nothing to answer here, so the act is to ask again.
    return (
      <section className="pb pb-pad" data-line-band="reask">
        <div className="pb-row">
          <dl className="pb-facts"><Fact k="Run" tone="warn">Paused, nobody asked</Fact></dl>
          <div className="pb-acts"><StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} label="Ask again…" /></div>
        </div>
      </section>
    );
  }
  if (b.kind === "ask" || (b.kind === "need" && !p.need)) {
    const ask = b.kind === "ask" ? b : null;
    return (
      <section className="pb pb-pad" data-line-band="ask">
        <ProblemAsk question={ask?.question ?? p.title} why={ask?.note ?? null} taskRef={p.taskRef} caseId={p.taskId} focus={p.askFocus} asks={ask?.required ?? true} />
      </section>
    );
  }

  let facts: ReactNode = null;
  let thing: ReactNode = null;
  let acts: ReactNode = null;
  switch (b.kind) {
    case "failed":
      // A step that ended without a report: the stage track already says so, and there is nothing it said to show.
      thing = !b.silent && (b.reason || b.output) && (
        <div className="pb-thing">
          {b.reason && <p className="pb-reason">{b.reason}</p>}
          {b.output && b.output !== b.reason && <pre className="pb-output">{b.output}</pre>}
        </div>
      );
      facts = <>{b.at != null && <Fact k={b.silent ? "Ended" : "Failed"}>{dayTimeWords(b.at)}</Fact>}<Fact k="Step">{b.step}</Fact>{b.after != null && <Fact k="After">{spanShort(b.after)}</Fact>}</>;
      acts = <>
        {b.runId && <button type="button" className="lw-act" onClick={() => p.onStep(b.runId!, b.node)} data-line-band-step>Open the step</button>}
        <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} />
      </>;
      break;
    case "stalled":
      facts = <><Fact k="Stage">{b.stage}</Fact><Fact k="Silent" tone="bad">{spanShort(b.silentMs)}</Fact>{b.last && <Fact k="Last output">{b.last.split("\n").filter(Boolean).pop()}</Fact>}</>;
      acts = <>
        {b.runId && <button type="button" className="lw-act" onClick={() => p.onStep(b.runId!, b.node)} data-line-band-step>Open the step</button>}
        <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} />
      </>;
      break;
    case "running":
      facts = <><Fact k="Stage">{b.stage}</Fact><Fact k="Running">{spanShort(b.ms)}</Fact>{ms != null && <Fact k="Usually done in">{aboutWords(ms)}</Fact>}</>;
      acts = b.runId && <button type="button" className="lw-link" onClick={() => p.onRun(b.runId!, p.taskId)}>Open the run</button>;
      break;
    case "merged":
      facts = <>
        <Fact k="Merged">{dayWords(b.mergedAt)}{b.link ? <Out href={b.link}>the pull request</Out> : b.sha ? <code className="pb-sha">{b.sha.slice(0, 7)}</code> : null}</Fact>
        {b.recorded === "known" && <Fact k="In production" tone="warn">No</Fact>}
        {b.recorded === "none" && <Fact k="In production">Not recorded for this project</Fact>}
        {b.recorded === "known" && b.coverage && <Fact k="Deploys">{b.coverage}</Fact>}
      </>;
      break;
    case "production":
      facts = <>
        {b.mergedAt != null && <Fact k="Merged">{dayWords(b.mergedAt)}{b.link ? <Out href={b.link}>the pull request</Out> : b.sha ? <code className="pb-sha">{b.sha.slice(0, 7)}</code> : null}</Fact>}
        <Fact k="In production" tone="ok">{dayWords(b.liveAt)}{b.target ? ` · ${b.target}` : ""}{b.deployUrl && <Out href={b.deployUrl}>the deploy</Out>}</Fact>
        {b.watch === "watching" && b.watchEnd != null && <Fact k="Watch ends">{dayWords(b.watchEnd)}</Fact>}
        <Fact k="Since" tone={b.since > 0 ? "bad" : "ok"}>{b.since > 0 ? `${b.since} ${b.since === 1 ? "finding" : "findings"}` : "No findings"}{b.sinceOff > 0 ? `, and ${b.sinceOff} about something else` : ""}</Fact>
      </>;
      break;
    case "approved": {
      // The line's merge step, read from its role when the org is on hand, else from what the ship step said.
      const off = merge ? !merge.on : b.mergeOff;
      facts = <>
        <Fact k="Approved">{b.at != null ? dayWords(b.at) : "Yes"}{b.ref && <a className="lw-link pb-out" href={`/decisions/${encodeURIComponent(b.ref)}`}>{b.ref}</a>}</Fact>
        <Fact k="Merged" tone="warn">No</Fact>
        <Fact k="In production" tone={b.recorded === "known" ? "warn" : undefined}>
          {b.recorded === "none" ? "Not recorded for this project" : b.recorded === "unread" ? "Reading the deploys" : "No"}
          {b.recorded === "known" && b.lastDeploy && <>{", last deploy "}{b.lastDeploy.url ? <Out href={b.lastDeploy.url}>{dayWords(b.lastDeploy.at)}</Out> : dayWords(b.lastDeploy.at)}</>}
        </Fact>
        {b.earlier && (
          <Fact k="Earlier fix">
            Run {b.earlier.n} merged {b.earlier.prUrl ? <Out href={b.earlier.prUrl}>{b.earlier.sha.slice(0, 7)}</Out> : <code className="pb-sha">{b.earlier.sha.slice(0, 7)}</code>} {dayWords(b.earlier.at)}
          </Fact>
        )}
        {b.change && b.change.files > 0 && <Fact k="Change"><span className="pb-stat">{b.change.files} {b.change.files === 1 ? "file" : "files"} <b data-k="add">+{b.change.added}</b> <b data-k="del">−{b.change.removed}</b></span>{b.change.pr && <Out href={b.change.pr}>the pull request</Out>}</Fact>}
        {off != null && (
          // The switch itself is MergeFixAct's, through its review: the fact only says how it stands.
          <Fact k="Merge step" tone={off ? "warn" : "ok"}>{off ? "Off" : "On"}</Fact>
        )}
      </>;
      acts = <>
        <MergeFixAct taskId={p.taskId} problem={problem} change={b.change} approved={b.ref ? `${b.ref}${b.at != null ? ` · ${dayWords(b.at)}` : ""}` : null} projectId={p.projectId} mergeStep={off == null ? null : !off} />
        <button type="button" className="lw-link" onClick={() => p.onRun(b.runId, p.taskId)}>Open the run</button>
      </>;
      break;
    }
    case "escalated":
      // What the step refused, in its own words; the count that decided it leads the facts.
      thing = b.why && <div className="pb-thing"><p className="pb-reason">{b.why}</p></div>;
      facts = <>
        {b.rejects && <Fact k="Reject the cause" tone="warn"><span className="pb-stat"><b>{b.rejects.n}</b> of {b.rejects.of} findings</span></Fact>}
        <Fact k="Handed back">{b.at != null ? dayTimeWords(b.at) : "Yes"}</Fact>
        <Fact k="Step">{b.step}</Fact>
      </>;
      acts = <>
        <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} label="Start again…" />
        <button type="button" className="lw-link" onClick={() => p.onRun(b.runId, p.taskId)} data-line-band-run>Open the run</button>
      </>;
      break;
    case "parked":
      thing = b.why && !b.fixedSha && <div className="pb-thing"><p className="pb-reason">{b.why}</p></div>;
      facts = <>
        {b.fixedSha && <Fact k="Fixed on main" tone="ok"><code className="pb-sha" title={b.fixedSha}>{b.fixedSha.slice(0, 7)}</code></Fact>}
        <Fact k="Parked">{b.at != null ? dayTimeWords(b.at) : "Yes"}</Fact>
        {b.fixedSha && b.why && <Fact k="Note">{fixNote(b.why)}</Fact>}
      </>;
      acts = <>
        {b.fixedSha ? <CloseAsFixed taskRef={p.taskRef ?? p.taskId} sha={b.fixedSha} /> : <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} label="Start again…" />}
        <button type="button" className="lw-link" onClick={() => p.onRun(b.runId, p.taskId)} data-line-band-run>Open the run</button>
      </>;
      break;
    case "trial":
      // A trial records the answer and ships nothing: what was chosen, what the fix changes, and closing it.
      facts = <>
        <Fact k="You chose" tone="ok">{b.verb}{b.at != null ? ` · ${dayWords(b.at)}` : ""}{b.ref && <a className="lw-link pb-out" href={`/decisions/${encodeURIComponent(b.ref)}`}>{b.ref}</a>}</Fact>
        <Fact k="Shipped">No, a trial ships nothing</Fact>
        {b.change && b.change.files > 0 && <Fact k="Change"><span className="pb-stat">{b.change.files} {b.change.files === 1 ? "file" : "files"} <b data-k="add">+{b.change.added}</b> <b data-k="del">−{b.change.removed}</b></span>{b.change.pr && <Out href={b.change.pr}>the pull request</Out>}</Fact>}
      </>;
      acts = <>
        <CloseProblem taskRef={p.taskRef ?? p.taskId} title="Close the problem: the trial has its answer" />
        <button type="button" className="lw-link" onClick={() => p.onRun(b.runId, p.taskId)} data-line-band-run>Open the run</button>
      </>;
      break;
    case "review":
      if (b.holder) {
        facts = <><Fact k="Held by">{b.holder}</Fact>{b.since != null && <Fact k="Since">{dayWords(b.since)}</Fact>}</>;
        break;
      }
      // Nobody holds it: the run ended and nothing is asked of anyone. What moves it is a new run.
      facts = <>{b.answer && <Fact k="You answered">{b.answer}</Fact>}{b.since != null && <Fact k="Run ended">{dayWords(b.since)}</Fact>}<Fact k="Held by" tone="warn">Nobody</Fact></>;
      acts = <>
        <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} label="Start again…" />
        {b.runId && <button type="button" className="lw-link" onClick={() => p.onRun(b.runId!, p.taskId)} data-line-band-run>Open the run</button>}
      </>;
      break;
    case "morefindings":
      facts = <><Fact k="Has">{b.has} {b.has === 1 ? "finding" : "findings"}</Fact>{b.needs && <Fact k="Needs">{b.needs}</Fact>}</>;
      break;
    case "closed":
      facts = <><Fact k="Closed">{b.at != null ? dayWords(b.at) : "Yes"}</Fact>{b.how && <Fact k="How">{b.how}</Fact>}{b.why && <Fact k="Why">{b.why}</Fact>}</>;
      break;
    case "notstarted":
      if (b.lineOn === false) {
        // The project's start switch, through the one review every paid switch goes through.
        // This problem's own state only: the line-wide queue says nothing about it.
        facts = <>{b.reason && <Fact k="Waiting on">{b.reason}</Fact>}<Fact k="Line" tone="warn">Off</Fact></>;
        acts = <LineStartControl projectId={p.projectId} project={p.projectTitle ?? undefined} className="lw-act" label={`Turn on ${p.projectTitle ? `${p.projectTitle}'s` : "its"} line…`} triggerProps={{ "data-primary": "", "data-line-band-turn-on": "" }} />;
      } else if (b.lineOn == null) {
        // No role starts this project's line: the step that sets one up.
        facts = <>{b.reason && <Fact k="Waiting on">{b.reason}</Fact>}<Fact k="Line" tone="warn">Not set up</Fact></>;
        acts = p.projectId && <a className="lw-act" data-primary="" href={lineSettingsHref({ project: p.projectId })} data-line-band-setup>Set up {p.projectTitle ? `${p.projectTitle}'s` : "its"} line</a>;
      } else {
        // Queued: it starts when the line has a free place; the line-wide queue is not this problem's.
        facts = <>{b.reason ? <Fact k="Waiting on">{b.reason}</Fact> : <Fact k="Starts">When the line has a free place</Fact>}<Fact k="Line" tone="ok">On</Fact></>;
      }
      break;
  }
  // A problem whose last run ended while the task still points at it: the sweep passes it by, so it starts by hand.
  if (b.kind === "notstarted" && b.restart) acts = <>{acts}<StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} label="Start again…" primary={!acts} /></>;
  return (
    <section className="pb pb-pad" data-line-band={b.kind}>
      {thing}
      <div className="pb-row">
        <dl className="pb-facts">{facts}</dl>
        {acts && <div className="pb-acts">{acts}</div>}
      </div>
    </section>
  );
}

/** Close a problem: one press, and the closed problem reopens if a finding comes back. */
function CloseProblem({ taskRef, title, label = "Close" }: { taskRef: string; title: string; label?: string }) {
  const done = useInboxStore((s) => (Object.values(s.tasks) as Array<{ short_id?: string; status?: string }>).find((t) => t.short_id === taskRef)?.status === "done");
  if (done) return <span className="lw-oc" data-tone="ok">Closed</span>;
  return (
    <button type="button" className="lw-act" data-primary="" title={title} data-line-band-close
      onClick={() => void useInboxStore.getState().updateTaskStatus(taskRef, "done")}>
      {label}
    </button>
  );
}

/** Close a problem whose fix main already carries. */
const CloseAsFixed = ({ taskRef, sha }: { taskRef: string; sha: string }) => <CloseProblem taskRef={taskRef} title={`Close it as fixed by ${sha.slice(0, 7)}`} label="Close as fixed" />;

/** A park note past its "Already fixed on main by <sha>" (the facts say that): "(classifies both files); CI on it in
 *  progress" reads "classifies both files; CI on it in progress". */
const fixNote = (note: string) => note.replace(/^already fixed on main by [0-9a-f]+\s*/i, "").replace(/^\(([^)]*)\)/, "$1").replace(/^[;,.\s]+/, "") || note;

