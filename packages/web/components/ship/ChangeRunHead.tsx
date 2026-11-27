"use client";
// A change run's page head (lib/ship/changePage.ts): where the change stands and what it waits on, the change's facts
// as links (its PR, CI, review, merged commit and deploys), then the run card's own track, under which the bar carries
// only what the person does (changeAction): each fact on the page once.
import { useMemo } from "react";
import Link from "next/link";
import { journeyOf, type TargetState } from "../../lib/ship/journey";
import { changeAction, changeHeadline, changeLinks, changePr, endedStages, mergeIsOff, type ChangeLink } from "../../lib/ship/changePage";
import { landedSha } from "../../lib/ship/runRecord";
import { onPrHead } from "@codecast/shared/contracts/deployTargets";
import { reachTargets } from "../../lib/ship/sessionShip";
import { roleRowsOf } from "../../lib/roleRows";
import { useDeployReachRead } from "../../hooks/useDeployReach";
import { useJourneyViewer } from "../../hooks/useJourneyViewer";
import { usePullRequestMerge } from "../../hooks/useSyncTimeline";
import { ReportChip } from "../line/RunReport";
import { JourneyView } from "./Journey";
import { ShipAgainButton } from "../line/widgets/RunThroughFlow";
import { useInboxStore } from "../../store/inboxStore";
import type { AppFlow } from "../../lib/line/flowPool";
import "./ship.css";

const CHIP_TONE: Record<ChangeLink["tone"], "ship" | "drop" | "revise" | "default"> = { ok: "ship", bad: "drop", wait: "revise", default: "default" };

/** `chips`: the page's own links (the session that ran it, the task), drawn after the change's. `newer`: a later run on
 *  the same task, where a stopped run's change went on. */
export function ChangeRunHead({ run: given, flow, now_ms, chips, newer }: { run: any; flow: AppFlow; now_ms: number; chips?: React.ReactNode; newer?: string | null }) {
  const pr = changePr(given);
  // Whether GitHub merged the PR (a person may have, outside the run), and where the deploy records put the merge.
  const prMerge = usePullRequestMerge(pr) ?? null;
  // Its verdicts judged on the head GitHub has the PR on, as the PR's header judges them.
  const run = useMemo(() => onPrHead(given, prMerge?.head_sha), [given, prMerge?.head_sha]);
  const sha = landedSha(run) ?? (prMerge?.merged ? prMerge.merge_sha : null);
  const { reach, ready: reachRead } = useDeployReachRead(sha && pr ? `${pr.repository}@${sha}` : null);
  const targets = useMemo<TargetState[]>(() => reachTargets(reach), [reach]);
  const viewer = useJourneyViewer(run);
  const journey = useMemo(() => journeyOf(flow, run, targets, viewer), [flow, run, targets, viewer]);
  const stages = useMemo(() => endedStages(journey, run, flow), [journey, run, flow]);
  // The role whose line started the run holds its merge switch: its page, read only when merge was off.
  const mergeRole = useInboxStore((s) => (run.org_role_id && mergeIsOff(run) ? roleRowsOf(s as any).roles.find((r) => r._id === run.org_role_id)?.short_id ?? null : null));
  const head = changeHeadline(journey, run, flow, { pr: prMerge, targets, reading: !reachRead });
  const links = changeLinks(run, flow, targets, prMerge);
  const action = changeAction(journey, run, flow, { newer, pr: prMerge, mergeRole, targets });
  const subject = run.spawner_conversation_id ? String(run.spawner_conversation_id) : null;
  const subjectTitle = useInboxStore((s) => (subject ? ((s.conversations as Record<string, { title?: string }>)[subject]?.title ?? (s.sessions as Record<string, { title?: string }>)[subject]?.title ?? null) : null));
  const act = !action ? null
    : action.kind === "again" && subject ? <ShipAgainButton flow={flow} conversationId={subject} sessionTitle={subjectTitle ?? run.task_title ?? "its session"} primary />
    : action.href ? <Link className="sj-act" data-primary href={action.href} data-change-act={action.kind}>{action.label}</Link>
    : null;
  return (
    <>
      <section data-run-report-head data-change-head={journey.now.kind}>
        <h2 className="cr-head" data-tone={head.tone}>
          <i className="cr-dot" aria-hidden />
          <span>{head.words}</span>
        </h2>
        {head.waits ? <p className="cr-waits" data-change-waits>{head.waits}</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-1.5" data-change-links>
          {links.map((l) => (
            <span key={`${l.kind}:${l.label}`} data-change-link={l.kind} className="contents">
              <ReportChip href={l.href} external={l.external} tone={CHIP_TONE[l.tone]} title={l.title}>{l.label}</ReportChip>
            </span>
          ))}
          {chips}
        </div>
      </section>
      <div className="sj cr-journey"><JourneyView journey={journey} stages={stages} run={run} now_ms={now_ms} targets={reach ? targets : undefined} act={act} onRunPage /></div>
    </>
  );
}
