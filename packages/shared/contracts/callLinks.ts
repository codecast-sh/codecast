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

/** A place inside a call: a run of transcript turns (by segment seq, both
 *  ends inclusive), the summary, or one action item (0-based). Every link
 *  into a call, from the page, a session or the CLI, is one of these. */
export type CallAnchor =
  | { kind: "turns"; from_seq: number; to_seq: number }
  | { kind: "summary" }
  | { kind: "action"; index: number };

/** The call page path for an anchor, or the whole call without one. Turns
 *  ride `?turns=<from>-<to>` (they open selected); the recap's parts ride
 *  `?part=summary` and `?part=action-<n>` (1-based, as people count them). */
export function callAnchorHref(transcriptId: string, anchor?: CallAnchor | null): string {
  const base = `/calls/${transcriptId}`;
  if (!anchor) return base;
  if (anchor.kind === "turns") return `${base}?turns=${anchor.from_seq}-${anchor.to_seq}`;
  return `${base}?part=${anchor.kind === "summary" ? "summary" : `action-${anchor.index + 1}`}`;
}

/** The anchor a call page URL names, or null for the whole call. */
export function parseCallAnchor(params: { get(name: string): string | null } | null | undefined): CallAnchor | null {
  const turns = params?.get("turns");
  if (turns) {
    const [from, to = from] = turns.split("-").map(Number);
    if (Number.isFinite(from) && Number.isFinite(to)) {
      return { kind: "turns", from_seq: Math.min(from, to), to_seq: Math.max(from, to) };
    }
  }
  const part = params?.get("part");
  if (part === "summary") return { kind: "summary" };
  const m = part ? /^action-(\d+)$/.exec(part) : null;
  if (m && Number(m[1]) >= 1) return { kind: "action", index: Number(m[1]) - 1 };
  return null;
}

/** The call page at a moment: `?t=<seconds>`, the player's position, the
 *  way video links everywhere say it. Whole seconds; the page seeks there and
 *  lights the line being said. Kept apart from CallAnchor on purpose: an
 *  anchor selects a place in the record, a moment positions the player, and
 *  one link can carry both. */
export function callMomentHref(transcriptId: string, atMs: number, anchor?: CallAnchor | null): string {
  const base = callAnchorHref(transcriptId, anchor);
  return `${base}${base.includes("?") ? "&" : "?"}t=${Math.max(0, Math.floor(atMs / 1000))}`;
}

/** The moment a call page URL names (`?t=754`, also `754s`), in ms, or null. */
export function parseCallMomentParam(params: { get(name: string): string | null } | null | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)s?$/.exec(params?.get("t")?.trim() ?? "");
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** One key per anchor, for the DOM attribute that marks it and for "landed once". */
export function callAnchorKey(anchor: CallAnchor): string {
  return anchor.kind === "turns"
    ? `turns-${anchor.from_seq}-${anchor.to_seq}`
    : anchor.kind === "summary"
      ? "summary"
      : `action-${anchor.index}`;
}

/** The call page link for one excerpt (those turns open selected), or the
 *  whole call when there is none. */
export function callExcerptHref(
  transcriptId: string,
  excerpt?: { from_seq: number; to_seq: number } | null,
): string {
  return callAnchorHref(transcriptId, excerpt ? { kind: "turns", ...excerpt } : null);
}

/** The call page link for a session's side of the link: the latest excerpt
 *  sent, or the whole call for a live feed. */
export function callLinkHref(transcriptId: string, link: CallLinkHow): string {
  return callExcerptHref(transcriptId, link.excerpts[link.excerpts.length - 1]);
}
