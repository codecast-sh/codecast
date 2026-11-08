// Rounds: how a room's agent members answer a line one at a time.
//
// Waking every member at once gets N replies written in parallel, none of
// which saw the others. A round hands the floor to one member at a time with
// the whole thread so far, so each reply can build on, correct or skip what
// came before. The round lives on the thread's root row; the server
// (convex/chatRounds.ts) does the waking, and these pure transitions decide
// who is next. Clients read the same shape to draw the turn strip.
//
// Bounds, so agents cannot talk forever: only a person's line or an agent's
// new root opens a round; a member speaks at most ROUND_MAX_TURNS times in
// it; a second lap runs only when someone spoke in the first, and there are
// at most ROUND_MAX_LAPS laps. A person's next line in the thread starts the
// count again.

export const ROUND_MAX_TURNS = 2;
export const ROUND_MAX_LAPS = 2;

export type RoundMemberState =
  | "waiting" // in the queue for this lap
  | "floor" // has the floor now
  | "spoke" // answered in the thread
  | "passed" // read the thread and ended its turn without answering
  | "busy" // was mid-turn when its turn came; moved to the end of the lap
  | "no_answer" // held the floor too long without reading or answering
  | "skipped" // a person moved the floor past it
  | "unreachable" // no running session to wake
  | "out"; // not asked in this round (a person named other members)

export type RoundMember = {
  /** The role id or conversation id of the chat_channel_agents row. */
  key: string;
  kind: "role" | "session";
  short_id: string;
  /** Snapshot for the wake and the strip: a role's @handle, a session's title. */
  name: string;
  /** The conversation a wake for this member landed in (a role's standing session). */
  session_id?: string;
  turns: number;
  state: RoundMemberState;
  /** Already moved to the end once for being busy: next time it is woken anyway. */
  deferred?: boolean;
};

export type ChatRound = {
  status: "open" | "done" | "ended";
  opened_at: number;
  updated_at: number;
  /** A person opened it (wakes carry the person's authority) or an agent's root did. */
  by_person: boolean;
  lap: number;
  spoke_in_lap: boolean;
  members: RoundMember[];
  /** Member keys still to take the floor this lap, in order. */
  queue: string[];
  floor_key?: string;
  floor_session_id?: string;
  floor_wake_id?: string;
  floor_since?: number;
  last_speaker?: string;
};

export type RoundMemberSeed = Pick<RoundMember, "key" | "kind" | "short_id" | "name">;

const canSpeak = (m: RoundMember) => m.turns < ROUND_MAX_TURNS && m.state !== "unreachable";

/** One lap's order: the members a line named first, in the order it named
 *  them, then everyone else in room order. When a line names members, only
 *  they are asked. */
function lapOrder(members: RoundMember[], named: string[], exclude: Set<string>): string[] {
  const eligible = new Map(members.filter((m) => canSpeak(m) && !exclude.has(m.key)).map((m) => [m.key, m]));
  const first = named.filter((k) => eligible.has(k));
  if (first.length > 0) return [...new Set(first)];
  return [...eligible.keys()];
}

function withStates(members: RoundMember[], queue: string[]): RoundMember[] {
  const queued = new Set(queue);
  return members.map((m) => (queued.has(m.key) ? { ...m, state: "waiting" as const, deferred: false } : m));
}

/** A new round on a thread. `exclude` holds the opener when it is itself a
 *  member (an agent's root already said its piece). */
export function startRound(
  seeds: RoundMemberSeed[],
  opts: { named: string[]; exclude?: string[]; byPerson: boolean; now: number },
): ChatRound {
  const members: RoundMember[] = seeds.map((s) => ({ ...s, turns: 0, state: "out" }));
  const exclude = new Set(opts.exclude ?? []);
  for (const m of members) if (exclude.has(m.key)) m.state = "spoke";
  const queue = lapOrder(members, opts.named, exclude);
  return {
    status: "open",
    opened_at: opts.now,
    updated_at: opts.now,
    by_person: opts.byPerson,
    lap: 1,
    spoke_in_lap: false,
    members: withStates(members, queue),
    queue,
    last_speaker: opts.exclude?.[0],
  };
}

/** A person spoke again in the thread: a fresh lap with fresh turn counts.
 *  The member holding the floor keeps it and is not queued again. Members
 *  added to the room since the round opened join it. */
export function restartRound(
  round: ChatRound,
  seeds: RoundMemberSeed[],
  opts: { named: string[]; now: number },
): ChatRound {
  const known = new Map(round.members.map((m) => [m.key, m]));
  const members: RoundMember[] = seeds.map((s) => {
    const prev = known.get(s.key);
    return prev
      ? { ...prev, ...s, session_id: prev.session_id, turns: 0, state: prev.state === "unreachable" ? "out" : prev.state }
      : { ...s, turns: 0, state: "out" as const };
  });
  const exclude = new Set(round.floor_key ? [round.floor_key] : []);
  const queue = lapOrder(members, opts.named, exclude);
  return {
    ...round,
    status: "open",
    updated_at: opts.now,
    by_person: true,
    lap: 1,
    spoke_in_lap: false,
    members: withStates(members, queue).map((m) => (queue.includes(m.key) || m.key === round.floor_key ? m : { ...m, state: "out" as const })),
    queue,
  };
}

/** The member whose session is `sessionId`, if any. */
export function memberForSession(round: ChatRound, sessionId: string): RoundMember | undefined {
  return round.members.find((m) => m.key === sessionId || m.session_id === sessionId);
}

/** What a member did with its turn. A reply that @mentions other members
 *  hands them the floor next, ahead of the queue. */
export function recordOutcome(
  round: ChatRound,
  key: string,
  outcome: "spoke" | "passed" | "no_answer" | "skipped",
  opts: { handTo?: string[]; now: number },
): ChatRound {
  const isFloor = round.floor_key === key;
  const members = round.members.map((m) => {
    if (m.key !== key) return m;
    return { ...m, state: outcome, turns: outcome === "spoke" ? m.turns + 1 : m.turns };
  });
  let queue = round.queue.filter((k) => k !== key);
  if (outcome === "spoke" && opts.handTo?.length) {
    const byKey = new Map(members.map((m) => [m.key, m]));
    const handTo = opts.handTo.filter((k) => k !== key && byKey.has(k) && canSpeak(byKey.get(k)!));
    queue = [...new Set(handTo), ...queue.filter((k) => !handTo.includes(k))];
  }
  const next: ChatRound = {
    ...round,
    updated_at: opts.now,
    members: withStates(members, queue.filter((k) => !round.queue.includes(k))),
    queue,
    spoke_in_lap: round.spoke_in_lap || outcome === "spoke",
    last_speaker: outcome === "spoke" ? key : round.last_speaker,
  };
  return isFloor ? clearFloor(next) : next;
}

function clearFloor(round: ChatRound): ChatRound {
  const { floor_key: _k, floor_session_id: _s, floor_wake_id: _w, floor_since: _t, ...rest } = round;
  return rest;
}

/** Who takes the floor next, or null when the round is over. Starts a second
 *  lap when the first produced at least one reply. */
export function nextCandidate(round: ChatRound, now: number): { round: ChatRound; key: string | null } {
  if (round.status !== "open" || round.floor_key) return { round, key: null };
  if (round.queue.length > 0) {
    const [key, ...queue] = round.queue;
    return { round: { ...round, queue }, key };
  }
  if (round.spoke_in_lap && round.lap < ROUND_MAX_LAPS) {
    const exclude = new Set(round.last_speaker ? [round.last_speaker] : []);
    const order = lapOrder(round.members.filter((m) => m.state !== "out"), [], exclude);
    if (order.length > 0) {
      const [key, ...queue] = order;
      return {
        round: { ...round, lap: round.lap + 1, spoke_in_lap: false, queue, members: withStates(round.members, order), updated_at: now },
        key,
      };
    }
  }
  return { round: { ...clearFloor(round), status: "done", updated_at: now }, key: null };
}

/** The member was mid-turn: it goes to the end of the lap, once. */
export function deferBusy(round: ChatRound, key: string): ChatRound {
  return {
    ...round,
    queue: [...round.queue.filter((k) => k !== key), key],
    members: round.members.map((m) => (m.key === key ? { ...m, state: "busy" as const, deferred: true } : m)),
  };
}

export function markUnreachable(round: ChatRound, key: string): ChatRound {
  return { ...round, members: round.members.map((m) => (m.key === key ? { ...m, state: "unreachable" as const } : m)) };
}

export function grantFloor(round: ChatRound, key: string, sessionId: string, wakeId: string, now: number): ChatRound {
  return {
    ...round,
    floor_key: key,
    floor_session_id: sessionId,
    floor_wake_id: wakeId,
    floor_since: now,
    updated_at: now,
    members: round.members.map((m) => (m.key === key ? { ...m, state: "floor" as const, session_id: sessionId } : m)),
  };
}

export function endRound(round: ChatRound, now: number): ChatRound {
  return {
    ...clearFloor(round),
    status: "ended",
    queue: [],
    updated_at: now,
    members: round.members.map((m) => (m.state === "floor" || m.state === "waiting" || m.state === "busy" ? { ...m, state: "skipped" as const } : m)),
  };
}

/** The strip's order: who has spoken or passed, the floor, then the queue. */
export function roundStrip(round: ChatRound): RoundMember[] {
  const queued = new Map(round.queue.map((k, i) => [k, i]));
  const rank = (m: RoundMember) =>
    m.state === "floor" ? 1 : queued.has(m.key) ? 2 + queued.get(m.key)! / 1000 : m.state === "out" ? 4 : 0;
  return round.members.filter((m) => m.state !== "out").sort((a, b) => rank(a) - rank(b));
}
