import { callParticipantKind, parseRoomKey } from "@codecast/shared/contracts";

// A call belongs to the people who were on it, not to the room it was held
// in. Ringing a third person into a 1:1 keeps the room key the two people
// started in (dm:a:b), so a room's past calls are not "this conversation's"
// history: the group call with Jason held in Ashot and Samvit's room is the
// three people's call. The rail's earlier calls match on people for that reason.

type PeopleCall = {
  _id: string;
  room_key: string;
  started_by?: string | null;
  started_at: number;
  participants?: Array<{ id: string; name: string }>;
  screen?: unknown;
};

/** A teammate's id, as a participant or a seat carries it: agents and
 *  guests are not the people a call is between. */
function isPersonId(id: string | null | undefined): id is string {
  return !!id && callParticipantKind(id) === "person";
}

/** Everyone who was on a call: whoever spoke, whoever started it, and the
 *  people a people room was opened for (a 1:1 where one side never spoke is
 *  still between both of them). */
export function callPeople(call: PeopleCall): string[] {
  const ids = new Set<string>();
  for (const p of call.participants ?? []) if (isPersonId(p.id)) ids.add(p.id);
  if (isPersonId(call.started_by ?? null)) ids.add(String(call.started_by));
  const parsed = parseRoomKey(call.room_key);
  if (parsed?.kind === "dm") for (const u of parsed.users) ids.add(u);
  return [...ids].sort();
}

/** The people seated now, as one canonical key: sorted unique person ids. */
export function peopleKey(ids: readonly string[]): string {
  return [...new Set(ids.filter(isPersonId))].sort().join(",");
}

/** Earlier calls held by exactly these people, newest first: one row each on
 *  the rail. Recordings and screen recordings are one person's, never a
 *  conversation between people, and the current call is the thread itself. */
export function earlierCallsWith<C extends PeopleCall>(
  calls: readonly C[],
  people: string,
  opts: { exclude?: string | null; before?: number; limit: number },
): C[] {
  if (!people.includes(",")) return [];
  const out: C[] = [];
  for (const c of calls) {
    if (out.length >= opts.limit) break;
    if (String(c._id) === opts.exclude || c.screen) continue;
    const kind = parseRoomKey(c.room_key)?.kind;
    if (kind === "rec" || kind === "meet") continue;
    if (opts.before !== undefined && c.started_at >= opts.before) continue;
    if (callPeople(c).join(",") === people) out.push(c);
  }
  return out;
}
