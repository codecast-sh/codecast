// How a call reached a session (call_session_links), in words: the call
// page's chips, the session header's pill and `cast call` all say it the
// same way.

export type CallLinkHow = {
  live: boolean;
  excerpts: Array<{ from_seq: number; to_seq: number; at: number }>;
};

export function callLinkHow(link: CallLinkHow): string {
  const n = link.excerpts.length;
  return [link.live ? "fed live" : "", n ? `${n === 1 ? "an excerpt" : `${n} excerpts`} sent` : ""]
    .filter(Boolean)
    .join(", ");
}

/** The call page link for one excerpt (those turns open selected), or the
 *  whole call when there is none. */
export function callExcerptHref(
  transcriptId: string,
  excerpt?: { from_seq: number; to_seq: number } | null,
): string {
  return excerpt ? `/calls/${transcriptId}?turns=${excerpt.from_seq}-${excerpt.to_seq}` : `/calls/${transcriptId}`;
}

/** The call page link for a session's side of the link: the latest excerpt
 *  sent, or the whole call for a live feed. */
export function callLinkHref(transcriptId: string, link: CallLinkHow): string {
  return callExcerptHref(transcriptId, link.excerpts[link.excerpts.length - 1]);
}
