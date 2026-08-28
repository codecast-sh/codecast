// THE JOIN, SAID IN WORDS.
//
// A burst becoming a call is the biggest thing that happens in the walkie and
// it used to happen in silence on the sender's side: the strip turned into the
// call dock, the mic stayed open, and nothing anywhere said why. The founder
// asked for "a message like hey he joined", and this is where that sentence
// lives for the four seconds it is news, on both sides of the same moment —
// "Jordan joined" for the person who was talking, "You joined Jordan" for the
// person who pressed the button.
//
// A module singleton rather than a field on WalkieStatus, and rather than
// component state. Not the engine, because a title with a lifetime is not a
// fact about the room and the engine's state is being collapsed rather than
// grown (A4). Not the dock's own state, because both writers are outside it:
// the far side's stamp arrives in a hook, and this client's own join happens
// in the engine. One tiny module, one timer, and it disappears with the
// feature it belongs to.
//
// Everything below the announcement itself is pure, so the copy is pinned by a
// test rather than by whatever a component happened to render.

/** How long the join stays on the dock. Four seconds is long enough to read
 *  without looking for it and short enough that the room's own name is back
 *  before anybody wonders what the title is stuck on. */
export const JOIN_TITLE_MS = 4_000;

export type JoinAnnouncement = { roomKey: string; text: string; at: number };

let announcement: JoinAnnouncement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

function wake() {
  for (const cb of subscribers) cb();
}

export function subscribeJoinAnnouncement(cb: () => void): () => void {
  subscribers.add(cb);
  return () => void subscribers.delete(cb);
}

export function getJoinAnnouncement(): JoinAnnouncement | null {
  return announcement;
}

/** Somebody stepped into this room. Says so for JOIN_TITLE_MS, then stops.
 *
 *  The timer is what ends it rather than a clock the reader has to poll: a
 *  surface reading this is already subscribed, so the expiry arrives as an
 *  ordinary wake and no component owns an interval for it. */
export function announceJoin(roomKey: string, text: string): void {
  announcement = { roomKey, text, at: Date.now() };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    announcement = null;
    wake();
  }, JOIN_TITLE_MS);
  wake();
}

/** The room ended, or a test is starting. */
export function clearJoinAnnouncement(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!announcement) return;
  announcement = null;
  wake();
}

/** The far side stepped into the burst I am speaking. */
export function theyJoinedText(name?: string | null): string {
  return `${name?.trim() || "Somebody"} joined — it's a call now`;
}

/** I stepped into the burst somebody is speaking to me. */
export function youJoinedText(name?: string | null): string {
  const who = name?.trim();
  return who ? `You joined ${who}` : "You joined the call";
}

/**
 * What the dock's title says right now.
 *
 * Pure, and the whole state machine: the announcement wins for its four
 * seconds, in the room it names and no other, and the room's ordinary title
 * takes over the moment either of those stops being true. The `now` test is
 * belt and braces against a timer that a suspended tab ran late — a title is
 * never allowed to outlive its moment and go on claiming somebody just walked
 * in.
 */
export function joinTitle(
  announcement: JoinAnnouncement | null,
  roomKey: string | null,
  now: number,
  fallback: string,
): string {
  if (!announcement || !roomKey) return fallback;
  if (announcement.roomKey !== roomKey) return fallback;
  if (now - announcement.at >= JOIN_TITLE_MS) return fallback;
  return announcement.text;
}
