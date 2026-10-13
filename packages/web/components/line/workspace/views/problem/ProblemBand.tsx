"use client";
// The act band of a problem's page (line-journeys.md LJ8.3): always drawn,
// and in exactly one state. It never restates the stage track's line; it
// holds the thing (what waits on a person, through the one reader), fact rows,
// and at most one act. Where nothing is owed it says so with facts alone.
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { objectHref } from "@codecast/shared/entities";
import { useInboxStore } from "../../../../../store/inboxStore";
import type { LineNeed } from "../../../../../lib/line/lineNeeds";
import type { LineAdmission } from "../../../../../lib/lineFlow";
import { dayTimeWords, dayWords, spanShort, type ProblemBand as Band } from "../../../../../lib/line/problemPage";
import { aboutWords, useRunDuration } from "../../../../../lib/line/runDuration";
import { LineDecision } from "../../../widgets/LineDecision";
import { StartRunAct } from "../../../widgets/StartRunAct";
import { WaitingItem } from "../../../widgets/WaitingItem";
import { answerNext, ProblemAsk } from "./AskBlock";
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
    const s = answerNext(p.admission, p.startable);
    const ask = b.kind === "ask" ? b : null;
    return (
      <section className="pb pb-pad" data-line-band="ask">
        <ProblemAsk question={ask?.question ?? p.title} why={ask?.note ?? null} taskRef={p.taskRef} focus={p.askFocus} asks={ask?.required ?? true} startWords={s.words} />
        {s.under === "off" && <p className="pb-under">Starts when {p.projectTitle ?? "this project"}'s line is turned on. <a className="lw-link" href={p.notStartedHref} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); p.onNotStarted(); }}>Turn it on</a></p>}
      </section>
    );
  }

  let facts: ReactNode = null;
  let thing: ReactNode = null;
  let acts: ReactNode = null;
  switch (b.kind) {
    case "failed":
      thing = (b.reason || b.output) && (
        <div className="pb-thing">
          {b.reason && <p className="pb-reason">{b.reason}</p>}
          {b.output && b.output !== b.reason && <pre className="pb-output">{b.output}</pre>}
        </div>
      );
      facts = <>{b.at != null && <Fact k="Failed">{dayTimeWords(b.at)}</Fact>}<Fact k="Step">{b.step}</Fact>{b.after != null && <Fact k="After">{spanShort(b.after)}</Fact>}</>;
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
        {b.change && b.change.files > 0 && <Fact k="Change"><span className="pb-stat">{b.change.files} {b.change.files === 1 ? "file" : "files"} <b data-k="add">+{b.change.added}</b> <b data-k="del">−{b.change.removed}</b></span>{b.change.pr && <Out href={b.change.pr}>the pull request</Out>}</Fact>}
        {off != null && (
          <Fact k="Merge step" tone={off ? "warn" : "ok"}>
            {off ? "Off" : "On"}
            {off && merge && <a className="lw-link pb-out" href={objectHref("role", merge.ref)} data-line-merge-step>Turn on</a>}
          </Fact>
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
        {b.fixedSha && b.why && <Fact k="Note">{b.why.replace(/^already fixed on main by [0-9a-f]+\s*/i, "").replace(/^[(;,\s]+|[)\s]+$/g, "") || b.why}</Fact>}
      </>;
      acts = <>
        {b.fixedSha ? <CloseAsFixed taskRef={p.taskRef ?? p.taskId} sha={b.fixedSha} /> : <StartRunAct taskId={p.taskId} projectId={p.projectId} problem={problem} label="Start again…" />}
        <button type="button" className="lw-link" onClick={() => p.onRun(b.runId, p.taskId)} data-line-band-run>Open the run</button>
      </>;
      break;
    case "review":
      facts = <><Fact k="Status">In review</Fact>{b.since != null && <Fact k="Since">{dayWords(b.since)}</Fact>}</>;
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
        facts = <><Fact k="Line" tone="warn">Off</Fact>{b.ready != null && <Fact k="Ready">{b.ready}</Fact>}{b.blocked != null && <Fact k="Blocked">{b.blocked}</Fact>}{b.reason && <Fact k="This one">{b.reason}</Fact>}</>;
        acts = <LineStartControl projectId={p.projectId} project={p.projectTitle ?? undefined} className="lw-act" label={`Turn on ${p.projectTitle ? `${p.projectTitle}'s` : "its"} line…`} triggerProps={{ "data-primary": "", "data-line-band-turn-on": "" }} />;
      } else if (b.lineOn == null) {
        // No role starts this project's line: the step that sets one up.
        facts = <><Fact k="Line" tone="warn">Not set up</Fact>{b.reason && <Fact k="This one">{b.reason}</Fact>}</>;
        acts = p.projectId && <a className="lw-act" data-primary="" href={lineSettingsHref({ project: p.projectId })} data-line-band-setup>Set up {p.projectTitle ? `${p.projectTitle}'s` : "its"} line</a>;
      } else {
        facts = <><Fact k="Line" tone="ok">On</Fact>{b.reason ? <Fact k="This one">{b.reason}</Fact> : <Fact k="Queue">{p.admission?.queued != null ? `${p.admission.queued} waiting to start` : "Waiting for a free place"}</Fact>}</>;
      }
      break;
  }
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

/** Close a problem whose fix main already carries: one press, and the closed problem reopens if a finding comes back. */
function CloseAsFixed({ taskRef, sha }: { taskRef: string; sha: string }) {
  const done = useInboxStore((s) => (Object.values(s.tasks) as Array<{ short_id?: string; status?: string }>).find((t) => t.short_id === taskRef)?.status === "done");
  if (done) return <span className="lw-oc" data-tone="ok">Closed</span>;
  return (
    <button type="button" className="lw-act" data-primary="" title={`Close it as fixed by ${sha.slice(0, 7)}`} data-line-band-close
      onClick={() => void useInboxStore.getState().updateTaskStatus(taskRef, "done")}>
      Close as fixed
    </button>
  );
}
