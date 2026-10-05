// How a call reached a session (call_session_links), in words: the call
// page's chips, the session header's pill and `cast call` all say it the
// same way.

import { CALL_FRAME_PREFER, type CallRecordingKind } from "./callRecordings";

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

/** What a call is called in a URL: its short id (`cl-42`) when it has one,
 *  else its full id. The short id is the one the page header shows, agents
 *  cite and `cast call` prints, so the address bar and a copied link name the
 *  call the way everything else does. The page reads either. */
export function callPathRef(call: { _id: string; short_id?: string | null }): string {
  return call.short_id || String(call._id);
}

/** The call page path for an anchor, or the whole call without one. `call`
 *  is callPathRef's answer where the caller has the record, a full id where
 *  it has only that. Turns ride `?turns=<from>-<to>` (they open selected);
 *  the recap's parts ride `?part=summary` and `?part=action-<n>` (1-based,
 *  as people count them). */
export function callAnchorHref(call: string, anchor?: CallAnchor | null): string {
  const base = `/calls/${call}`;
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
export function callMomentHref(transcriptId: string, atMs: number, anchor?: CallAnchor | null, view?: CallView | null): string {
  const base = callAnchorHref(transcriptId, anchor);
  const at = `${base}${base.includes("?") ? "&" : "?"}t=${Math.max(0, Math.floor(atMs / 1000))}`;
  const v = callViewParam(view);
  return v ? `${at}&view=${v}` : at;
}

/** A view as the `view` param spells it (parseCallViewParam reads it back),
 *  or null for the room, which needs no word. One spelling for a link built
 *  whole (callMomentHref) and for the page writing its own address. */
export function callViewParam(view?: CallView | null): string | null {
  if (!view?.screen) return null;
  return `screen${view.identity ? `:${encodeURIComponent(view.identity)}` : ""}`;
}

/**
 * The call page at the moment a frame shows, on the picture it shows. Every
 * surface that links a frame (the `cl-42@12:34` embed, `cast call snap`'s
 * call_url, the player's Link button) builds it here, so a link never opens
 * the room under a frame of a screen. `shown` is the file the frame came
 * from: a screen's file names its sharer (`view=screen:<identity>`), the
 * room's names no view. Without one (a citation, which has not chosen a file
 * yet) the link takes the view a citation renders, CALL_FRAME_PREFER.
 */
export function callFrameHref(
  transcriptId: string,
  atMs: number,
  shown?: { kind: CallRecordingKind; participant_identity?: string | null } | null,
): string {
  const screen = shown ? shown.kind === "screen" : CALL_FRAME_PREFER === "screen";
  return callMomentHref(transcriptId, atMs, null, screen ? { screen: true, identity: shown?.participant_identity ?? null } : null);
}

/** The moment a call page URL names (`?t=754`, also `754s`), in ms, or null. */
export function parseCallMomentParam(params: { get(name: string): string | null } | null | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)s?$/.exec(params?.get("t")?.trim() ?? "");
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** What a link to a moment shows. The call page's player opens on the room
 *  (the file with everyone's sound), so the room is the default and needs no
 *  word. A screen rides `&view=screen`: the shared screen covering that
 *  moment, the one a `cl-42@12:34` citation renders (CALL_FRAME_PREFER), or
 *  with `:<participant identity>` one person's screen, which is what the
 *  player's Link copies while a screen is the view. The page falls back to
 *  the room where no screen of that kind covers the moment. */
export type CallView = { screen: true; identity?: string | null };

/** The view a call page URL names (`view=screen`, `view=screen:<identity>`),
 *  or null for the room. */
export function parseCallViewParam(params: { get(name: string): string | null } | null | undefined): CallView | null {
  const m = /^screen(?::(.+))?$/.exec(params?.get("view")?.trim() ?? "");
  if (!m) return null;
  let identity: string | null = null;
  try {
    identity = m[1] ? decodeURIComponent(m[1]) : null;
  } catch {
    identity = m[1] ?? null;
  }
  return { screen: true, identity };
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
