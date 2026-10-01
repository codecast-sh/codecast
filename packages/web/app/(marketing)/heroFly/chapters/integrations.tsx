"use client";

/**
 * Chapter 10, GitHub: pull request #482 as the pull request page draws it:
 * the header with its shepherd, linked sessions and task, the checks figure,
 * the tab bar, and the conversation timeline. Sarah approves, the checks go
 * green one by one, and it merges; the merged chip then flies to the page.
 */

import { useMemo } from "react";
import { PrStatusChip } from "@/components/PrStatusChip";
import { PRHeader } from "@/components/pr/PRHeader";
import { PRTabBar } from "@/components/pr/PRTabBar";
import { PRTimeline } from "@/components/pr/PRTimeline";
import { accentVar } from "@/lib/externalEvents";
import { buildPrTimeline, PR_STATE_META, prStateKey } from "@/lib/prView";
import "@/components/pr/pr.css";
import { events, MERGED_STATUS, pullRequest, reviews } from "../fixtures/integrations";
import { OBJECTS, SESSIONS } from "../fixtures/story";
import { fly, useFilmTime } from "../filmClock";
import { stageAt } from "./integrations.motion";
import type { PartProps } from "./contract";

const noop = () => {};
const SESSION_CHOICES = [SESSIONS.lead, SESSIONS.api, SESSIONS.ui].map((s) => ({ id: s.shortId, title: s.title }));

export function PullRequestPage({ now }: PartProps) {
  // One of a fixed set of moments, so the page renders only when something it shows changes.
  const stage = useFilmTime(stageAt);
  const pr = pullRequest(now, stage);
  const prReviews = reviews(now, stage);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => buildPrTimeline({ events: events(now, stage), reviews: prReviews, comments: [] }), [now, stage]);

  return (
    <div className="pr-page flex h-full flex-col overflow-hidden" style={{ ["--pr-accent" as string]: accentVar(PR_STATE_META[prStateKey(pr)].accent) }}>
      <div {...fly("pr/integrations.header")}>
        <PRHeader
          pr={pr}
          repository={OBJECTS.pr.repository}
          number={OBJECTS.pr.number}
          openComments={0}
          reviews={prReviews}
          linkedSessionIds={pr.linked_session_ids}
          sessionChoices={SESSION_CHOICES}
          onSetShepherd={noop}
        />
      </div>
      <PRTabBar
        repository={OBJECTS.pr.repository}
        number={OBJECTS.pr.number}
        title={pr.title}
        tab="conversation"
        filesCount={pr.changed_files}
        notesCount={0}
        commitsCount={pr.commits_count}
        checksCount={pr.checks.length}
        pastHeader={false}
      />
      {/* The newest entry stays in view, as if the page followed the timeline down; the oldest row the tab bar would cut fades out under it instead. */}
      <div
        className="flex min-h-0 max-w-[1080px] flex-1 flex-col justify-end overflow-hidden"
        {...fly("pr/integrations.timeline", { maskImage: "linear-gradient(to bottom, transparent, #000 56px)", WebkitMaskImage: "linear-gradient(to bottom, transparent, #000 56px)" })}
      >
        <PRTimeline pr={pr} items={items} comments={[]} authed={false} onPostComment={noop} onResolve={noop} onNavigate={noop} />
      </div>
    </div>
  );
}

/** The merge, carried to the published page: the real pull request chip. */
export function MergedFlyer() {
  return (
    <div className="-translate-x-1/2 -translate-y-1/2 scale-[1.6] rounded-md bg-sol-bg p-1 shadow-xl">
      <PrStatusChip status={MERGED_STATUS} size="panel" />
    </div>
  );
}
