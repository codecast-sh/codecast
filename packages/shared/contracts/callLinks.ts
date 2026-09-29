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

/** The call page link for a session's side of the link: the latest excerpt
 *  sent opens with those turns selected; a live feed opens the whole call. */
export function callLinkHref(transcriptId: string, link: CallLinkHow): string {
  const last = link.excerpts[link.excerpts.length - 1];
  return last ? `/calls/${transcriptId}?turns=${last.from_seq}-${last.to_seq}` : `/calls/${transcriptId}`;
}
