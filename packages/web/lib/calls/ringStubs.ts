// The stub ring: a ringing row in myCalls.outgoing that stands in for the
// invite from the press until the server lists the person itself.
//
// startHuddle seats the caller before the invite goes out, and every seat
// write re-pushes getMyCalls (it reads call_members too), so a plain replace
// of the list would drop the stub a tick before the real row lands and the
// face would read online in between. The store's merge for the list carries
// a live stub across a push that has no row for that person; the engine
// withdraws one by writing it with an expired clock, which the merge drops.
export const RING_STUB = "stub:";
/** How long a stub may stand without the server's row: the invite's round
 *  trip is about a second; this bounds a stub whose row never comes. */
export const RING_STUB_MS = 15_000;

export type RingStub = {
  _id: string;
  room_key: string;
  to_user: string;
  to_name: string;
  status: "ringing";
  created_at: number;
  until: number;
};

export const ringStubId = (roomKey: string, userId: string): string => `${RING_STUB}${roomKey}:${userId}`;
export const isRingStub = (r: any): r is RingStub => typeof r?._id === "string" && r._id.startsWith(RING_STUB);

/** The merge for myCalls.outgoing: the incoming list, less any expired stub,
 *  plus every live local stub the incoming list says nothing about. */
export function carryRingStubs(local: any[] | undefined, incoming: any[] | undefined, now = Date.now()): any[] {
  const rows = incoming ?? [];
  const kept = rows.filter((r) => !isRingStub(r) || r.until > now);
  const names = (r: any, s: any) => String(s._id) === String(r._id) || (s.room_key === r.room_key && String(s.to_user) === String(r.to_user));
  const carried = (local ?? []).filter((r) => isRingStub(r) && r.until > now && !rows.some((s) => names(r, s)));
  return carried.length ? [...kept, ...carried] : kept;
}
