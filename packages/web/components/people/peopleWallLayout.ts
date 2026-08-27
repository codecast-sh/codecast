// The wall of faces: how big each person is drawn, in what order, and where the
// line between a tap and a hold falls. React-free so it is unit-testable under
// bun, the same split peopleRoster.ts and memberPresence.ts live under.
import { MIN_BURST_MS } from "../../lib/calls/walkie";
import type { FleetSummary, PresenceVisual } from "../presence/memberPresence";

/**
 * How long a press can last and still be a CLICK rather than a hold.
 *
 * THE FACE IS BOTH GESTURES, so this number decides which one happened, and it
 * only works because of a second number it must stay under. A press opens the
 * microphone immediately — waiting 300ms to find out whether somebody meant to
 * talk would eat the first word of every sentence, which is the one thing a
 * push-to-talk key may never do. So a tap DOES start a burst.
 *
 * It costs nothing, because the engine throws away any burst shorter than
 * MIN_BURST_MS (700ms, lib/calls/walkie.ts) — a brush against a key is not a
 * sentence, and it never was. Every gesture this function calls a tap is
 * therefore a gesture the engine discards before it can land anywhere. The two
 * numbers are load-bearing together, and a test pins the gap between them.
 */
export const WALL_TAP_MS = 300;

/** The shortest hold the engine will keep. Re-exported rather than mirrored:
 *  a copied 700 would pin nothing, because the day somebody moved the engine's
 *  number the copy would still agree with itself and the test guarding the gap
 *  would still pass. This is the same binding the engine discards against. */
export const WALL_BURST_FLOOR_MS = MIN_BURST_MS;

/**
 * Was that a tap? Both arguments come from one clock (performance.now()), so a
 * system clock change mid-press cannot turn a hold into a click.
 *
 * The boundary belongs to the HOLD: a press of exactly WALL_TAP_MS is somebody
 * holding a key, not somebody clicking one. Ties go to the gesture that keeps
 * the microphone open, because the failure that way round is a burst the engine
 * discards, and the other way round is a sentence nobody hears.
 */
export function isWallTap(downAt: number, upAt: number): boolean {
  return upAt - downAt < WALL_TAP_MS;
}

/**
 * The six sizes a face can be, biggest first.
 *
 * SIZE IS PRESENCE PLUS ACTIVITY, and the wall is readable across a room
 * because of it: who is here and doing something is unmissable, who left
 * yesterday is a pebble. Names for what each one MEANS, so the mapping below
 * reads as a sentence rather than as a table of pixels.
 */
export type WallTier = "loud" | "here" | "idle" | "away" | "gone";

export const WALL_FACE_PX: Record<WallTier, number> = {
  /** At the machine with agents running: the person most worth a word. */
  loud: 88,
  /** At the machine, nothing running. Present and quiet. */
  here: 64,
  /** The heartbeat went quiet a few minutes ago. */
  idle: 44,
  /** Gone from the keyboard, or said so themselves. */
  away: 32,
  /** Not there. Small enough that a team of forty absentees costs one row. */
  gone: 26,
};

const TIER_ORDER: WallTier[] = ["loud", "here", "idle", "away", "gone"];

/** Something of theirs is running or waiting on them right now. */
export function hasFleetActivity(fleet: FleetSummary | null | undefined): boolean {
  return !!fleet && (fleet.working > 0 || fleet.needsYou > 0);
}

/**
 * How big to draw one person.
 *
 * Busy is deliberately NOT shrunk. Somebody who set do-not-disturb is at the
 * machine — more certainly there than most, since they took the trouble to say
 * so — and the red badge already carries the guard. Making them small would say
 * "not here", which is the opposite of what they told the team.
 */
export function wallTier(
  visual: PresenceVisual,
  fleet: FleetSummary | null | undefined,
): WallTier {
  if (visual === "offline") return "gone";
  if (visual === "away") return "away";
  if (visual === "idle") return "idle";
  // active or busy: both are at the machine.
  return hasFleetActivity(fleet) ? "loud" : "here";
}

export function wallFacePx(
  visual: PresenceVisual,
  fleet: FleetSummary | null | undefined,
): number {
  return WALL_FACE_PX[wallTier(visual, fleet)];
}

export interface WallFace<T> {
  id: string;
  member: T;
  tier: WallTier;
  px: number;
}

export interface Wall<T> {
  /** Everyone who is there at all, biggest first. */
  present: WallFace<T>[];
  /** The people who are not, gathered at the bottom. */
  gone: WallFace<T>[];
}

/**
 * The wall, laid out.
 *
 * Ordered by SIZE and then by name, which is the one ordering that reads as a
 * cluster rather than as a list: the big faces gather at the top left and the
 * small ones trail after them, and flex-wrap does the rest. Within a size it is
 * name order and nothing else, so a heartbeat cannot reshuffle the wall under a
 * thumb that is reaching for somebody.
 *
 * Offline is a separate group rather than a tail of the same one, because it
 * gets its own quiet row: people who are not there must not sit shoulder to
 * shoulder with people who are.
 */
export function buildWall<T>(
  members: T[],
  visualOf: (m: T) => PresenceVisual,
  fleetOf: (m: T) => FleetSummary | null,
  idOf: (m: T) => string,
  nameOf: (m: T) => string,
  /** Pixel size per tier — the wall's own by default; the strip hands in its
   *  shrunken table and everything else about the layout stays shared. */
  sizes: Record<WallTier, number> = WALL_FACE_PX,
): Wall<T> {
  const present: WallFace<T>[] = [];
  const gone: WallFace<T>[] = [];
  for (const member of members) {
    if (!member) continue;
    const id = idOf(member);
    if (!id) continue;
    const tier = wallTier(visualOf(member), fleetOf(member));
    const face: WallFace<T> = { id, member, tier, px: sizes[tier] };
    (tier === "gone" ? gone : present).push(face);
  }
  const byTierThenName = (a: WallFace<T>, b: WallFace<T>) => {
    const d = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
    return d !== 0 ? d : nameOf(a.member).localeCompare(nameOf(b.member));
  };
  present.sort(byTierThenName);
  gone.sort((a, b) => nameOf(a.member).localeCompare(nameOf(b.member)));
  return { present, gone };
}
