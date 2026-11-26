"use client";
// A change run's page head (lib/ship/changePage.ts): where the change stands and what it waits on, the change's facts
// as links (its PR, CI, review, merged commit and deploys), then the run card's own journey, whose bar under the track
// carries the person's part (an answer, the session, Deploys).
import { useMemo } from "react";
import Link from "next/link";
import { journeyOf, type TargetState } from "../../lib/ship/journey";
import { changeHeadline, changeLinks, changePr, type ChangeLink } from "../../lib/ship/changePage";
import { landedSha } from "../../lib/ship/runRecord";
import { reachTargets } from "../../lib/ship/sessionShip";
import { useDeployReach } from "../../hooks/useDeployReach";
import { useJourneyViewer } from "../../hooks/useJourneyViewer";
import { ReportChip } from "../line/RunReport";
import { JourneyView } from "./Journey";
import { ShipAgainButton } from "../line/widgets/RunThroughFlow";
import { useInboxStore } from "../../store/inboxStore";
import type { AppFlow } from "../../lib/line/flowPool";
import "./ship.css";

const CHIP_TONE: Record<ChangeLink["tone"], "ship" | "drop" | "revise" | "default"> = { ok: "ship", bad: "drop", wait: "revise", default: "default" };

/** `chips`: the page's own links (the session that ran it, the task), drawn after the change's. */
export function ChangeRunHead({ run, flow, now_ms, chips }: { run: any; flow: AppFlow; now_ms: number; chips?: React.ReactNode }) {
  // Where the deploy records put the merged commit, on every target it touches.
  const sha = landedSha(run);
  const pr = changePr(run);
  const reach = useDeployReach(sha && pr ? `${pr.repository}@${sha}` : null);
  const targets = useMemo<TargetState[]>(() => reachTargets(reach), [reach]);
  const viewer = useJourneyViewer(run);
  const journey = useMemo(() => journeyOf(flow, run, targets, viewer), [flow, run, targets, viewer]);
  const head = changeHeadline(journey, run, flow);
  const links = changeLinks(run, flow, targets);
  // A stop the run card answers with Ship again (the session's change through the same flow) offers it here too.
  const subject = run.spawner_conversation_id ? String(run.spawner_conversation_id) : null;
  const subjectTitle = useInboxStore((s) => (subject ? ((s.conversations as Record<string, { title?: string }>)[subject]?.title ?? (s.sessions as Record<string, { title?: string }>)[subject]?.title ?? null) : null));
  const again = subject ? (primary: boolean) => <ShipAgainButton flow={flow} conversationId={subject} sessionTitle={subjectTitle ?? run.task_title ?? "its session"} primary={primary} /> : undefined;
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
      <div className="sj cr-journey"><JourneyView journey={journey} run={run} now_ms={now_ms} targets={reach ? targets : undefined} again={again} onRunPage /></div>
    </>
  );
}
