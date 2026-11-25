"use client";

import { memo, useMemo } from "react";
import { useDecisionQueue } from "../../hooks/useDecisionQueue";
import { usePageEmbedFeed } from "../../hooks/usePageInfo";
import { PreloadPublishedPage } from "../PublishedPageEmbed";
import type { QueueItem } from "../../lib/decisionQueue";

// The reports attached to queued decisions, held before anyone opens one: the
// sync host feeds every queued report's page info into the shared store, and
// each window that draws the queue loads the first few frames so the leading
// decisions open with their report already painted.

/** Frames preloaded per window: the decisions a person opens first. */
const PRELOADED_FRAMES = 3;

const reportPages = (queue: QueueItem[]) =>
  queue.filter((i) => i.reportSlug && i.source === "decide").map((i) => ({ slug: i.reportSlug!, decision: i.key.replace(/^decide:/, "") }));

/** Sync host: page info for every queued decision's report. */
export const DecisionPagesFeeder = memo(function DecisionPagesFeeder() {
  const queue = useDecisionQueue();
  usePageEmbedFeed(useMemo(() => reportPages(queue), [queue]));
  return null;
});

/** Every window: the leading decisions' report frames. */
export const DecisionFramesPreload = memo(function DecisionFramesPreload() {
  const queue = useDecisionQueue();
  const pages = useMemo(() => reportPages(queue).slice(0, PRELOADED_FRAMES), [queue]);
  return <>{pages.map((p) => <PreloadPublishedPage key={p.slug} slug={p.slug} decision={p.decision} />)}</>;
});
