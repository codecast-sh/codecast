"use client";
// The act band of a problem's page (line-journeys.md LJ8.3): always drawn,
// and in exactly one state. It never restates the stage track's line; it
// holds the thing (what waits on a person, through the one reader), fact rows,
// and at most one act. Where nothing is owed it says so with facts alone.
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import type { LineNeed } from "../../../../../lib/line/lineNeeds";
import type { LineAdmission } from "../../../../../lib/lineFlow";
import { dayTimeWords, dayWords, spanShort, type ProblemBand as Band } from "../../../../../lib/line/problemPage";
import { aboutWords, useRunDuration } from "../../../../../lib/line/runDuration";
import { startsAtOnce } from "../../../map/LineStartSwitch";
import { LineDecision } from "../../../widgets/LineDecision";
import { StartRunAct } from "../../../widgets/StartRunAct";
import { WaitingItem } from "../../../widgets/WaitingItem";
import { ProblemAsk } from "./AskBlock";

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

/** What answering a question does next, from the project's admission: said on the Answer button (LJ6.2). */
function answerStart(a: LineAdmission | null, startable: boolean): { words: string | null; under: string | null } {
  if (!a) return { words: null, under: null };
  if (!a.on) return { words: null, under: "off" };
  if (!startable) return { words: null, under: null };
  const free = Math.max(0, a.slots - (a.busy ?? 0));
  if (free > 0 && (startsAtOnce({ ...a, queued: (a.queued ?? 0) + 1 }) ?? 1) > (a.queued ?? 0)) return { words: "starts now", under: null };
  return { words: a.queued != null ? `queued behind ${a.queued}` : "queued", under: null };
}

export function ProblemBand(p: ProblemBandProps) {
  const { band: b } = p;
  const ms = useRunDuration(p.projectId);
  const problem = p.taskRef ? `${p.taskRef} · ${p.title}` : p.title;

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
  if (b.kind === "ask" || (b.kind === "need" && !p.need)) {
    const s = answerStart(p.admission, p.startable);
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
      facts = <>{b.at != null && <Fact k="Failed">{dayTimeWords(b.at)}</Fact>}<Fact k="Step">{b.step}</Fact></>;
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
    case "approved":
      thing = b.why && <div className="pb-thing"><p className="pb-reason">{b.why}</p></div>;
      facts = <>
        <Fact k="Approved">{b.at != null ? dayWords(b.at) : "Yes"}{b.ref && <a className="lw-link pb-out" href={`/decisions/${encodeURIComponent(b.ref)}`}>{b.ref}</a>}</Fact>
        <Fact k="Merged" tone="warn">No</Fact>
        <Fact k="In production" tone="warn">No</Fact>
      </>;
      acts = <button type="button" className="lw-link" onClick={() => p.onRun(b.runId, p.taskId)}>Open the run</button>;
      break;
    case "morefindings":
      facts = <><Fact k="Has">{b.has} {b.has === 1 ? "finding" : "findings"}</Fact>{b.needs && <Fact k="Needs">{b.needs}</Fact>}</>;
      break;
    case "closed":
      facts = <><Fact k="Closed">{b.at != null ? dayWords(b.at) : "Yes"}</Fact>{b.how && <Fact k="How">{b.how}</Fact>}{b.why && <Fact k="Why">{b.why}</Fact>}</>;
      break;
    case "notstarted":
      if (b.lineOn === false) {
        facts = <><Fact k="Line" tone="warn">Off</Fact>{b.ready != null && <Fact k="Ready">{b.ready}</Fact>}{b.blocked != null && <Fact k="Blocked">{b.blocked}</Fact>}{b.reason && <Fact k="This one">{b.reason}</Fact>}</>;
        acts = <a className="lw-act" data-primary="" href={p.notStartedHref} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); p.onNotStarted(); }} data-line-band-turn-on>Turn on {p.projectTitle ? `${p.projectTitle}'s` : "its"} line</a>;
      } else {
        facts = b.reason ? <Fact k="Not started">{b.reason}</Fact> : <><Fact k="Line">{b.lineOn ? "On" : "Not set up for this project"}</Fact>{b.lineOn && <Fact k="Queue">{p.admission?.queued != null ? `${p.admission.queued} waiting to start` : "Waiting for a free place"}</Fact>}</>;
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
