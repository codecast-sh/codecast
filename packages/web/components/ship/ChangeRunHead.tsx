"use client";
// A change run's page head (lib/ship/changePage.ts): where the change stands and what it waits on, the change's facts
// as links (its PR, CI, review, merged commit and deploys), then the run card's own journey, whose bar under the track
// carries the person's part (an answer, the session, Deploys) and, on a stop, the one way on (stopAction).
import { useMemo } from "react";
import Link from "next/link";
import { journeyOf, type TargetState } from "../../lib/ship/journey";
import { changeHeadline, changeLinks, changePr, stopAction, type ChangeLink } from "../../lib/ship/changePage";
import { landedSha } from "../../lib/ship/runRecord";
import { reachTargets } from "../../lib/ship/sessionShip";
import { useDeployReach } from "../../hooks/useDeployReach";
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
export function ChangeRunHead({ run, flow, now_ms, chips, newer }: { run: any; flow: AppFlow; now_ms: number; chips?: React.ReactNode; newer?: string | null }) {
  const pr = changePr(run);
  // Whether GitHub merged the PR (a person may have, outside the run), and where the deploy records put the merge.
  const prMerge = usePullRequestMerge(pr) ?? null;
  const sha = landedSha(run) ?? (prMerge?.merged ? prMerge.merge_sha : null);
  const reach = useDeployReach(sha && pr ? `${pr.repository}@${sha}` : null);
  const targets = useMemo<TargetState[]>(() => reachTargets(reach), [reach]);
  const viewer = useJourneyViewer(run);
  const journey = useMemo(() => journeyOf(flow, run, targets, viewer), [flow, run, targets, viewer]);
  const head = changeHeadline(journey, run, flow, { pr: prMerge });
  const links = changeLinks(run, flow, targets, prMerge);
  const act = stopAction(journey, run, { newer, pr: prMerge });
  const subject = run.spawner_conversation_id ? String(run.spawner_conversation_id) : null;
  const subjectTitle = useInboxStore((s) => (subject ? ((s.conversations as Record<string, { title?: string }>)[subject]?.title ?? (s.sessions as Record<string, { title?: string }>)[subject]?.title ?? null) : null));
  const stopAct = !act ? undefined
    : act.kind === "again" && subject ? <ShipAgainButton flow={flow} conversationId={subject} sessionTitle={subjectTitle ?? run.task_title ?? "its session"} primary />
    : act.href ? <Link className="sj-act" data-primary href={act.href} data-change-act={act.kind}>{act.label}</Link>
    : undefined;
  return (
    <>
      <section data-run-report-head data-change-head={journey.now.kind}>
        <h2 className="cr-head" data-tone={head.tone}>
          <i className="cr-dot" aria-hidden />
          <span>{head.words}</span>
        </h2>
        {head.waits ? <p className="cr-waits" data-change-waits>{head.href ? <Link href={head.href} className="cr-waits-link">{head.waits}</Link> : head.waits}</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-1.5" data-change-links>
          {links.map((l) => (
            <span key={`${l.kind}:${l.label}`} data-change-link={l.kind} className="contents">
              <ReportChip href={l.href} external={l.external} tone={CHIP_TONE[l.tone]} title={l.title}>{l.label}</ReportChip>
            </span>
          ))}
          {chips}
        </div>
      </section>
      <div className="sj cr-journey"><JourneyView journey={journey} run={run} now_ms={now_ms} targets={reach ? targets : undefined} stopAct={stopAct ?? null} onRunPage /></div>
    </>
  );
}
