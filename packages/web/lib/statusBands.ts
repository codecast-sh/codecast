// The fleet board's bands in the Modern style: the rail's own sections, read
// through the status vocabulary (lib/sessionStatus), so a tile and the card
// for the same session say the same word in the same colour. Classic keeps its
// stricter supervision bands (components/fleetBands.ts); this replaces them only
// where the Modern board draws.

import type { InboxSession, PlacedInbox } from "../store/inboxStore";
import { placedRailPlacement, railRowPlacement, showsBlockedBadge, isAgentActive } from "../store/inboxStore";
import { bandOfStatus, sessionStatusOf, STATUS_BANDS, type SessionStatus, type StatusBand } from "./sessionStatus";

export type StatusTile = { session: InboxSession; status: SessionStatus };
export type StatusBands = Record<StatusBand, StatusTile[]>;

export type StatusBandOpts = {
  /** Client-queued sends (store.sessionsWithQueuedMessages). */
  queued: ReadonlySet<string>;
  /** Optimistic outbox sends (sessionsWithPendingSend). */
  pendingSendIds: ReadonlySet<string>;
  /** Fresh revive stamps (store.blockedReviveRequestedAt). */
  reviveAt?: Record<string, number>;
  /** A hosted row that ended on a stop notice (the rail's Couldn't finish): its kind. */
  stopped?: (s: InboxSession) => string | null;
  /** Coarse clock (useCoarseNow), never Date.now() in render. */
  now: number;
};

/**
 * Split the placed inbox (placeInboxRows) into the board's bands. The rows are
 * the same union the Classic board bands (splitFleetBands): every placed
 * section, plus blanks whose agent is starting or whose first send is in
 * flight. Each takes the state its placement gives it.
 */
export function splitStatusBands(
  placed: Pick<PlacedInbox, "questions" | "pinned" | "needsInput" | "done" | "dormant" | "working" | "newSessions"> & Partial<Pick<PlacedInbox, "placements">>,
  opts: StatusBandOpts,
): StatusBands {
  const out = Object.fromEntries(STATUS_BANDS.map((b) => [b, [] as StatusTile[]])) as StatusBands;
  const inFlight = (s: InboxSession) => opts.queued.has(s._id) || opts.pendingSendIds.has(s._id);
  const place = (s: InboxSession) => {
    const pendingSend = inFlight(s);
    const status = sessionStatusOf({
      row: s,
      placement: (placed.placements && placedRailPlacement(placed as Pick<PlacedInbox, "placements">, s._id)) ?? railRowPlacement(s, opts.now),
      now: opts.now,
      live: {
        pendingSend,
        blocked: showsBlockedBadge(s.pending_api_error, pendingSend, opts.reviveAt?.[s._id], opts.now),
        stopped: !!opts.stopped?.(s),
      },
    });
    const band = bandOfStatus(status);
    if (band) out[band].push({ session: s, status });
  };
  for (const s of [...placed.questions, ...placed.pinned, ...placed.needsInput, ...placed.done, ...placed.dormant, ...placed.working]) place(s);
  for (const s of placed.newSessions) if (isAgentActive(s, opts.now) || inFlight(s)) place(s);
  const at = (t: StatusTile) => t.session.updated_at ?? 0;
  // Longest-waiting first where the person is the next move; running tiles
  // hold a stable order (creation time) so a coarse tick never reshuffles them;
  // the rest newest first.
  out.needs_you.sort((a, b) => at(a) - at(b));
  out.working.sort((a, b) => ((b.session.started_at ?? at(b)) - (a.session.started_at ?? at(a))) || a.session._id.localeCompare(b.session._id));
  for (const band of ["done", "dormant", "idle"] as const) out[band].sort((a, b) => at(b) - at(a));
  return out;
}
