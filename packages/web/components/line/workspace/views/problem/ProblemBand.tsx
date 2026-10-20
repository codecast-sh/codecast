"use client";
// The act band of a problem's page (line-journeys.md LJ8.3): always drawn,
// and in exactly one state. It never restates the stage track's line; it
// holds the thing (what waits on a person, through the one reader), fact rows,
// and at most one act. Where nothing is owed it says so with facts alone.
import { useMemo, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { entityRoute } from "../../../../../lib/entityLinks";
import { useInboxStore } from "../../../../../store/inboxStore";
import type { LineNeed } from "../../../../../lib/line/lineNeeds";
import type { LineAdmission } from "../../../../../lib/lineFlow";
import { dayTimeWords, dayWords, lastShipFailure, NO_STEP, overrun, rebaseLandLedger, spanShort, stepDone, stopRunLedger, type ProblemBand as Band } from "../../../../../lib/line/problemPage";
import { aboutWords, useRunDuration } from "../../../../../lib/line/runDuration";
import { LineDecision } from "../../../widgets/LineDecision";
import { BranchName, ClosedDecisionDock, useRunBranch } from "../../../widgets/ClosedDecisionActs";
import { StartRunAct } from "../../../widgets/StartRunAct";
import { WaitingItem } from "../../../widgets/WaitingItem";
import { answerProblem, ProblemAsk } from "./AskBlock";
import { MergeFixAct } from "./MergeFixAct";
import { CloseAsFixed, CloseProblem } from "./CloseProblem";
import { LandAgain } from "./LandAgain";
import { LineStartControl } from "../../../../consequential/lineStart";
import { lineSettingsHref } from "../../../../../lib/lineSettings";
import { moveFindingLedger } from "../../../../../lib/line/findingLedger";
import { SwitchReview, type SwitchLedger } from "../../../../consequential/ConsequentialSwitch";
import { useFixBranch, useFixCommitChecks, useProblemCiRun } from "../../../../../hooks/useFixCommitChecks";
import { failingTestOf, fixCiFacts, fixedNoteRest } from "../../../../../lib/line/fixedOnMain";

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
  /** The newest commit a finding names as merged that is not this fix's merge (problemPage citedMerge). */
  cited?: { sha: string; at: number } | null;
  /** The run the live one took over from, stalled after a finished step that waited on a go-on (problemPage workRows). */
  replaces?: { n: number; step: string; redone: boolean | null } | null;
};

type LandingRun = Parameters<typeof lastShipFailure>[0][number] & { task_id?: string };

/** Over a Ship ask, the last time this problem tried to ship and failed (ct-59561: Run 5's ship refused a branch behind
 *  main and exited 1), and how the branch stands against main now: whether pressing Ship meets the same refusal. */
function LastShip({ taskId, projectId }: { taskId: string; projectId: string | null }) {
  const sig = useInboxStore((s) => {
    const rows = Object.values((s as unknown as { workflowRuns?: Record<string, LandingRun> }).workflowRuns ?? {}).filter((r) => r.task_id === taskId);
    return JSON.stringify({ last: lastShipFailure(rows), newest: rows.reduce<LandingRun | null>((m, r) => ((r.created_at ?? 0) > (m?.created_at ?? -1) ? r : m), null)?._id ?? null });
  });
  const { last, newest } = JSON.parse(sig) as { last: ReturnType<typeof lastShipFailure>; newest: string | null };
  const branch = useFixBranch(last ? projectId : null, null, last ? newest : null);
  if (!last) return null;
  const behind = branch?.behind ?? null;
  return (
    <section className="pb pb-pad" data-line-band="lastship" aria-label="The last time it tried to ship">
      <dl className="pb-facts">
        <Fact k="Last ship" tone="bad">Run {last.n}{last.at != null ? ` · ${dayTimeWords(last.at)}` : ""} · {last.said ?? "failed, said nothing"}</Fact>
        {behind != null && (behind > 0
          ? <Fact k="Branch now" tone="bad">{behind} behind {branch?.base ?? "main"}{last.behind ? " · Ship is refused again until it is rebased" : ""}</Fact>
          : <Fact k="Branch now" tone="ok">Up to date with {branch?.base ?? "main"}</Fact>)}
      </dl>
    </section>
  );
}

/** Findings after a close that say the same thing: what they say, how many, and what moving them out takes (a finding
 *  leaves with every finding under its source key: `signals` is one per key, `moving` how many leave in all). */
export type SinceGroup = { says: string; n: number; signals: string[]; moving: number };

const Fact = ({ k, children, tone }: { k: string; children: ReactNode; tone?: "bad" | "warn" | "ok" }) => (
  <div className="pb-fact" data-tone={tone}><dt>{k}</dt><dd>{children}</dd></div>
);
const Out = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="lw-link pb-out" href={href} target="_blank" rel="noreferrer">{children}<ArrowUpRight className="w-3 h-3" aria-hidden /></a>
);

/** A deploy's day and time: a merge and a deploy on the same day are told apart by the hour. */
const deployWhen = (at: number) => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** How long ago, short: "1h ago", "12h ago", "3d ago". */
const relWords = (ms: number) => `${spanShort(Math.max(0, ms))} ago`;

/** After "In production: No", what it is measured against: the project's last recorded production deploy, or none yet. */
const LastDeploy = ({ d }: { d: { at: number; url: string | null } | null }) => (
  <span data-line-last-deploy={d ? new Date(d.at).toISOString().slice(0, 10) : "none"}>
    {d ? <>{"· last deploy "}{d.url ? <Out href={d.url}>{deployWhen(d.at)}</Out> : deployWhen(d.at)}</> : "· no deploy recorded yet"}
  </span>
);


/** A merge links its pull request, or the commit that landed it on main when none did (tasks.landed). */
const mergeLinkWords = (link: string) => (/\/commit\//.test(link) ? "the commit" : "the pull request");
export function ProblemBand(p: ProblemBandProps) {
  const { band: b } = p;
  const branch = useRunBranch(b.kind === "approved" ? b.runId : null, b.kind === "approved" ? p.taskId : null);
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
      <>
      {b.need === "decision" && <LastShip taskId={p.taskId} projectId={p.projectId} />}
      <section className="pb pb-need" data-line-band={b.need} data-boxed={boxed ? "" : undefined} aria-label="What waits on you">
        <WaitingItem need={p.need} evidence={false} onProblem={p.onProblem} onRun={p.onRun} head={false} now={p.now} />
      </section>
      </>
    );
  }
  if (b.kind === "decision") {
    return (
      <>
      <LastShip taskId={p.taskId} projectId={p.projectId} />
      <section className="pb pb-need" data-line-band="decision" data-boxed="" aria-label="The decision on this problem">
        <LineDecision key={b.ref} id={b.ref} onProblem={p.onProblem} onRun={p.onRun} head={false} />
      </section>
      </>
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
    case "failed": {
      // A step that ended without a report: the stage track already says so, and there is nothing it said to show.
      // A reason that is only the head of the words shown whole below says nothing more: its step and word head them.
      const head = b.reason?.split(": ")[0] ?? null;
      const said = b.reason?.slice((head?.length ?? 0) + 2).replace(/…$/, "") ?? "";
      const reason = b.output && said && b.output.startsWith(said) ? head : b.reason;
      thing = !b.silent && (reason || b.output) && (
        <div className="pb-thing">
          {reason && <p className="pb-reason">{reason}</p>}
          {b.output && b.output !== b.reason && <pre className="pb-output">{b.output}</pre>}
        </div>
      );
      // With no step on record the band's line says what the run's record does: no Step fact and no step to open.
      facts = <>{b.at != null && <Fact k={b.silent ? "Ended" : b.stop ? "Stopped" : "Failed"}>{dayTimeWords(b.at)}</Fact>}{b.step !== NO_STEP && <Fact k="Step">{b.step}</Fact>}{b.after != null && <Fact k="After">{spanShort(b.after)}</Fact>}</>;
      // A step that stopped short by its own word (blocked, found no miss) may be right that there is nothing to do:
      // closing the problem sits beside starting it again.
      acts = <>
        {b.runId && b.node && <button type="button" className="lw-act" onClick={() => p.onStep(b.runId!, b.node)} data-line-band-step>Open the step</button>}
        {b.runId && !b.node && <button type="button" className="lw-link" onClick={() => p.onRun(b.runId!, p.taskId)} data-line-band-run>Open the run</button>}
        {b.stop && !b.cap && p.taskRef && <button type="button" className="lw-act" onClick={() => answerProblem(p.taskRef!, "dropped")} data-line-band-drop>Not a problem</button>}
        {/* A fix an earlier run built waits on the yes nobody gave: landing it leads, proving it again is the slow way. */}
        {b.built && <MergeFixAct taskId={p.taskId} problem={problem} change={null} approved={null} />}
        <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} primary={!b.built} />
      </>;
      break;
    }
    case "stalled":
      facts = <><Fact k="Stage">{b.stage}</Fact><Fact k="Silent" tone="bad">{spanShort(b.silentMs)}</Fact>{b.last && <Fact k="Last output">{b.last.split("\n").filter(Boolean).pop()}</Fact>}</>;
      acts = <>
        {b.runId && <button type="button" className="lw-act" onClick={() => p.onStep(b.runId!, b.node)} data-line-band-step>Open the step</button>}
        <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} />
      </>;
      break;
    case "running": {
      // Far past its usual time it is overrunning: the session doing it opens here, and it can be stopped.
      const over = overrun(b.ms, ms);
      facts = <><Fact k="Stage">{b.stage}</Fact><Fact k="Running" tone={over ? "bad" : undefined}>{spanShort(b.ms)}{over ? ` · ${over}x usual` : ""}</Fact>{ms != null && <Fact k="Usually done in">{aboutWords(ms)}</Fact>}
        {/* What became of the go-on the run before waited on: this run took over, its step kept or done again. */}
        {p.replaces && <Fact k="Replaces" tone="warn">Run {p.replaces.n}: {stepDone(p.replaces.step).toLowerCase()}, waited on a go-on{p.replaces.redone ? ` · ${p.replaces.step} again` : p.replaces.redone === false ? ` · ${p.replaces.step} kept` : ""}</Fact>}</>;
      acts = <>
        {over && b.sessionId && <a className="lw-act" data-primary="" href={`/conversation/${b.sessionId}`} data-line-band-session>Open the session</a>}
        {over && b.runId && <StopRun runId={b.runId} ledger={stopRunLedger({ problem, step: b.step, ms: b.ms, usual: ms })} />}
        {b.runId && <button type="button" className="lw-link" onClick={() => p.onRun(b.runId!, p.taskId)}>Open the run</button>}
      </>;
      break;
    }
    case "merged":
      facts = <>
        {/* The merge's hour beside the last deploy's: whether that deploy could have carried it reads at a glance. */}
        <Fact k="Merged">{dayTimeWords(b.mergedAt)}{b.link ? <Out href={b.link}>{mergeLinkWords(b.link)}</Out> : b.sha ? <code className="pb-sha">{b.sha.slice(0, 7)}</code> : null}</Fact>
        {b.recorded === "known" && <Fact k="In production" tone="warn">No<LastDeploy d={b.lastDeploy} />{b.lastDeploy && b.lastDeploy.at > b.mergedAt && <span data-line-deploy-after> · after the merge, did not carry it</span>}</Fact>}
        {b.recorded === "none" && <Fact k="In production">Not recorded for this project</Fact>}
      </>;
      break;
    case "production":
      facts = <>
        {b.mergedAt != null && <Fact k="Merged">{dayTimeWords(b.mergedAt)}{b.link ? <Out href={b.link}>{mergeLinkWords(b.link)}</Out> : b.sha ? <code className="pb-sha">{b.sha.slice(0, 7)}</code> : null}</Fact>}
        <Fact k="In production" tone="ok">{deployWhen(b.liveAt)}{b.target ? ` · ${b.target}` : ""}{b.deployRef ? <Link href={entityRoute("deploy", b.deployRef) ?? "#"} className="pb-deploy" data-line-band-deploy={b.deployRef}> · {b.deployRef}</Link> : b.deployUrl && <Out href={b.deployUrl}>the deploy</Out>}</Fact>
        {b.watch === "watching" && b.watchEnd != null && <Fact k="Watch ends">{dayWords(b.watchEnd)}</Fact>}
        {/* What the headline counts: findings and the line's own failures on the fault. */}
        <Fact k="Since" tone={b.since > 0 || b.faults.length ? "bad" : "ok"}>{[
          b.since > 0 ? `${b.since} ${b.since === 1 ? "finding" : "findings"}` : null,
          b.faults.length ? `${b.faults.length} line ${b.faults.length === 1 ? "failure" : "failures"}` : null,
        ].filter(Boolean).join(" · ") || "No findings"}{b.sinceOff > 0 ? `, and ${b.sinceOff} about something else` : ""}</Fact>
      </>;
      // The line's own runs that failed on this very fault after it went live: each one, in the words its step printed.
      thing = b.faults.length > 0 && (
        <ul className="pb-since" aria-label="The line failed on it since" data-line-band-faults={b.faults.length}>
          {b.faults.map((f) => (
            <li key={`${f.runId}:${f.step}`} className="pb-since-g">
              <button type="button" className="lw-link pb-since-act" onClick={() => p.onRun(f.runId, f.caseId)} data-line-band-fault={f.runId}>{f.stepLabel} · {f.caseRef ?? "a run"}</button>
              <span className="pb-since-says">{f.words}</span>
              <span className="lw-num">{relWords(p.now - f.at)}</span>
            </li>
          ))}
        </ul>
      );
      acts = b.faults.length > 0 && <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} label="Reopen…" />;
      break;
    case "approved": {
      // The line's merge step, read from its role when the org is on hand, else from what the ship step said.
      const off = merge ? !merge.on : b.mergeOff;
      facts = <>
        <Fact k="Approved">{[b.by, b.at != null ? dayTimeWords(b.at) : null].filter(Boolean).join(" · ") || "Yes"}{b.ref && <a className="lw-link pb-out" href={`/decisions/${encodeURIComponent(b.ref)}`}>{b.ref}</a>}</Fact>
        {/* Which change is not merged: this run's branch. A commit a later finding calls merged is another change. */}
        <Fact k="Merged" tone="warn">No{branch && <> · <BranchName name={branch} /></>}</Fact>
        {b.behind && <Fact k="Landing" tone="warn">Refused: branch behind {b.behind}</Fact>}
        {p.cited && <Fact k="Cited merge"><code className="pb-sha">{p.cited.sha.slice(0, 7)}</code> · another change, not this fix</Fact>}
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
      const approved = [b.by, b.ref, b.at != null ? dayWords(b.at) : null].filter(Boolean).join(" · ") || "Yes";
      acts = <>
        {/* Refused for being behind: the line's own Rebase step puts it on the default branch, checks it, and ships it. */}
        {b.behind
          ? <LandAgain runId={b.runId} ledger={rebaseLandLedger({ problem, branch, base: b.behind, approved, change: b.change })} />
          : <MergeFixAct taskId={p.taskId} problem={problem} change={b.change} approved={approved} />}
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
        {/* The band's line already says "Already fixed on main (sha)": no fact repeats it. A fix found on main is not
            parked work: the facts are what that commit changed and when the run found it. */}
        {b.fixedSha ? <>
          {b.why && <Fact k="What it changed">{fixNote(b.why)}</Fact>}
          <FixCI projectId={p.projectId} sha={b.fixedSha} taskId={p.taskId} title={p.title} />
          <Fact k="Found">{b.at != null ? dayTimeWords(b.at) : "Yes"}</Fact>
        </> : <>
          <Fact k="Parked">{b.at != null ? dayTimeWords(b.at) : "Yes"}{b.times > 1 ? ` · ${b.times} runs in a row` : ""}</Fact>
          {b.noGoal && <Fact k="Goal" tone="warn">None it serves</Fact>}
        </>}
      </>;
      // A park that found nothing to change (a false positive, intended behavior) is closed by the person; a new run is
      // the second choice, for when they disagree with it.
      acts = <>
        {b.fixedSha ? <CloseAsFixed taskRef={p.taskRef ?? p.taskId} sha={b.fixedSha} projectId={p.projectId} taskId={p.taskId} /> : <>
          {b.readiness === "not_actionable" && <CloseProblem taskRef={p.taskRef ?? p.taskId} title="Close it: the run found nothing to change" label="Close: nothing to change" />}
          {/* Serving no goal, every run parks it again: closing it, or a goal that covers it, are what change that. */}
          {b.noGoal ? <>
            <CloseProblem taskRef={p.taskRef ?? p.taskId} title="Close it: it serves no goal, so every run parks it" label="Close: serves no goal" />
            <a className="lw-act" href="/goals" data-line-band-goals="">Add a goal it serves</a>
          </> : <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} label="Start again…" primary={b.readiness !== "not_actionable"} />}
        </>}
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


/** The fixing commit's CI as it stands now, read from GitHub (lib/line/fixedOnMain fixCiFacts): whether the test the
 *  problem names passes there, then the commit's other checks apart. */
function FixCI({ projectId, sha, taskId, title }: { projectId: string | null; sha: string; taskId: string; title: string }) {
  const ci = useFixCommitChecks(projectId, sha, useProblemCiRun(taskId));
  return <>{fixCiFacts(ci, failingTestOf(title)).map((f) => (
    <div key={f.key} data-line-fix-ci={f.key}><Fact k={f.k} tone={f.tone}>{f.url ? <Out href={f.url}>{f.v}</Out> : f.v}</Fact></div>
  ))}</>;
}

/** A park note as the band reads it (lib/line/fixedOnMain fixedNoteRest, the one reading For you shares). */
const fixNote = fixedNoteRest;

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

/** Stop a live run, through the same review every consequential act goes through. */
function StopRun({ runId, ledger }: { runId: string; ledger: SwitchLedger }) {
  const [reviewing, setReviewing] = useState(false);
  return (
    <>
      <button type="button" className="lw-act" aria-haspopup="dialog" onClick={() => setReviewing(true)} data-line-band-stop>Stop the run…</button>
      {reviewing && <SwitchReview ledger={ledger} onClose={() => setReviewing(false)} onConfirm={() => { setReviewing(false); void useInboxStore.getState().stopLineRun(runId); }} />}
    </>
  );
}
