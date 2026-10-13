"use client";
// The act band of a problem's page (line-journeys.md LJ8.3): always drawn,
// and in exactly one state. It never restates the stage track's line; it
// holds the thing (what waits on a person, through the one reader), fact rows,
// and at most one act. Where nothing is owed it says so with facts alone.
import { useMemo, useState, type ReactNode } from "react";
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
import { moveFindingLedger } from "../../../../../lib/line/findingLedger";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";

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
  /** A problem closed without a fix that kept getting findings: those findings, grouped by what each says is wrong. */
  sinceGroups?: ReadonlyArray<SinceGroup>;
  /** How many findings the problem holds: what stays when a group moves out. */
  findings: number;
};

/** Findings after a close that say the same thing: what they say, how many, and what moving them out takes (a finding
 *  leaves with every finding under its source key: `signals` is one per key, `moving` how many leave in all). */
export type SinceGroup = { says: string; n: number; signals: string[]; moving: number };

const Fact = ({ k, children, tone }: { k: string; children: ReactNode; tone?: "bad" | "warn" | "ok" }) => (
  <div className="pb-fact" data-tone={tone}><dt>{k}</dt><dd>{children}</dd></div>
);
const Out = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="lw-link pb-out" href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight className="w-3 h-3" aria-hidden /></a>
);

/** After "In production: No", what it is measured against: the project's last recorded production deploy, or none yet. */
const LastDeploy = ({ d }: { d: { at: number; url: string | null } | null }) => (
  <span data-line-last-deploy={d ? new Date(d.at).toISOString().slice(0, 10) : "none"}>
    {d ? <>{", last deploy "}{d.url ? <Out href={d.url}>{dayWords(d.at)}</Out> : dayWords(d.at)}</> : ", no deploy recorded yet"}
  </span>
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
        {b.recorded === "known" && <Fact k="In production" tone="warn">No<LastDeploy d={b.lastDeploy} /></Fact>}
        {b.recorded === "none" && <Fact k="In production">Not recorded for this project</Fact>}
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
          {b.recorded === "known" && <LastDeploy d={b.lastDeploy} />}
        </Fact>
        {b.earlier && (
          <Fact k="Earlier fix">
            Run {b.earlier.n} merged {b.earlier.prUrl ? <Out href={b.earlier.prUrl}>{b.earlier.sha.slice(0, 7)}</Out> : <code className="pb-sha">{b.earlier.sha.slice(0, 7)}</code>} {dayWords(b.earlier.at)}
          </Fact>
        )}
        {b.change && b.change.files > 0 && <Fact k="Change"><span className="pb-stat">{b.change.files} {b.change.files === 1 ? "file" : "files"} <b data-k="add">+{b.change.added}</b> <b data-k="del">−{b.change.removed}</b></span>{b.change.pr && <Out href={b.change.pr}>the pull request</Out>}</Fact>}
        {/* Who merges it, and where: the line when its merge step is on, else a person on the fix's pull request. */}
        {off != null && <Fact k="Merges">{off ? "A person, on the pull request" : "The line, once checks pass"}</Fact>}
      </>;
      acts = <>
        <MergeFixAct taskId={p.taskId} problem={problem} change={b.change} approved={[b.ref, b.at != null ? dayWords(b.at) : null].filter(Boolean).join(" · ") || "Yes"} />
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
        {/* The band's line already says "Already fixed on main (sha)": no fact repeats it. */}
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
    case "returned":
      // Closed without a fix, and the findings kept coming: what they say, in groups, each with the act that moves it.
      thing = !!p.sinceGroups?.length && (
        <ul className="pb-since" aria-label="Findings since the close">
          {p.sinceGroups.map((g) => (
            <li key={g.says} className="pb-since-g">
              <span className="lw-num pb-since-n">{g.n}</span>
              <span className="pb-since-says">{g.says}</span>
              {p.taskRef && <MoveSince group={g} problem={p.taskRef} left={Math.max(0, p.findings - g.moving)} />}
            </li>
          ))}
        </ul>
      );
      // When, how and how many are the stage track's line: the band adds only what the findings say and the acts.
      acts = <>
        <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} label="Reopen…" />
        <CloseProblem taskRef={p.taskRef ?? p.taskId} title="Keep it closed: these findings change nothing" label="Keep closed" primary={false} />
        {b.runId && <button type="button" className="lw-link" onClick={() => p.onRun(b.runId!, p.taskId)} data-line-band-run>Open the run</button>}
      </>;
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
  // Grounding found nothing to change: what it said, and closing it is the person's act (a run can still be started).
  if (b.kind === "notstarted" && b.nothing != null) {
    thing = b.nothing && <div className="pb-thing"><p className="pb-reason">{b.nothing}</p></div>;
    // The stage line says it is held, and whether the line is on is beside the point: grounding's word is the thing.
    facts = null;
    acts = <>{acts}<CloseProblem taskRef={p.taskRef ?? p.taskId} title="Close it: grounding found nothing to change" label="Close: nothing to change" /></>;
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
function CloseProblem({ taskRef, title, label = "Close", primary = true }: { taskRef: string; title: string; label?: string; primary?: boolean }) {
  const done = useInboxStore((s) => (Object.values(s.tasks) as Array<{ short_id?: string; status?: string }>).find((t) => t.short_id === taskRef)?.status === "done");
  if (done) return <span className="lw-oc" data-tone="ok">Closed</span>;
  return (
    <button type="button" className="lw-act" data-primary={primary ? "" : undefined} title={title} data-line-band-close
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

/** Move one group of findings since the close out to a problem of their own, through the same review a single finding's
 *  "Not this problem" uses. */
function MoveSince({ group: g, problem, left }: { group: SinceGroup; problem: string; left: number }) {
  const [reviewing, setReviewing] = useState(false);
  const ledger = useMemo(() => moveFindingLedger({ problem, count: g.moving, left }), [problem, g.moving, left]);
  return (
    <>
      <button type="button" className="lw-link pb-since-act" aria-haspopup="dialog" onClick={() => setReviewing(true)} data-line-move-since={g.says.slice(0, 40)}>{g.moving === 1 ? "Move it out…" : `Move ${g.moving} out…`}</button>
      {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); for (const id of g.signals) void useInboxStore.getState().moveFindingOut(id); }} />}
    </>
  );
}
