"use client";

// A pull request's changed files inside a card (the conversation's PR card, a
// shared-object card), read when the card opens. The store's pull request
// rows carry no files (lib/detailRows): mounting this is what loads them, so
// a card mounts it only once it is expanded.

import { FileDiffList, type DiffFile } from "../FileDiffView";
import { usePullRequestDetail, useSyncPullRequestDetail } from "../../hooks/useSyncTimeline";

export function PullRequestFiles({ id, files, emptyText, className }: {
  /** The pull request's row id. */
  id: string | undefined;
  /** Files the caller already holds (a fixture's whole object): shown as they are, and nothing is read. */
  files?: DiffFile[] | null;
  emptyText?: string;
  className?: string;
}) {
  const feed = useSyncPullRequestDetail(files ? undefined : id);
  const detail = usePullRequestDetail(files ? undefined : id);
  const shown = files ?? (detail?.files as DiffFile[] | undefined);
  // Until the first answer, an empty list would read as "no files".
  const settled = !!files || !!detail || feed.ready || !!feed.error || !id;
  return <FileDiffList files={shown} emptyText={settled ? emptyText : undefined} className={className} />;
}
