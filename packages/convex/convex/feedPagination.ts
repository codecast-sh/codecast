// Pagination protocol for conversation feeds. Pure TS (no convex imports) so
// the protocol is unit-testable with fake page-fetchers — the invariants here
// (no skipped rows, every page makes client-visible progress, honest
// end-of-history) are exactly the ones that have repeatedly broken in
// production and they're impossible to verify through the full query stack.

// Walk an updated_at-desc conversations index in batches, skipping rows the
// caller filters out, until `want` rows are accepted, the read budget runs out,
// or the index is exhausted. Reports the continuation point honestly so a short
// page is never mistaken for end-of-history: `oldestSeen` is the oldest RAW row
// examined (resume with lt(oldestSeen)); `exhausted` is true only when the
// index truly ran dry.
export async function batchScanConversations(opts: {
  fetchPage: (cursor: number | null, take: number) => Promise<any[]>;
  startCursor: number | null;
  want: number;
  accept: (c: any) => boolean;
  batchSize: number;
  maxBatches?: number;
}): Promise<{ rows: any[]; oldestSeen: number | null; exhausted: boolean }> {
  const { fetchPage, startCursor, want, accept, batchSize, maxBatches = 5 } = opts;
  const rows: any[] = [];
  let cursor = startCursor;
  let oldestSeen: number | null = null;
  let exhausted = false;
  for (let i = 0; i < maxBatches && rows.length < want; i++) {
    const batch = await fetchPage(cursor, batchSize);
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const c of batch) {
      if (accept(c)) {
        rows.push(c);
        if (rows.length >= want) break;
      }
    }
    cursor = batch[batch.length - 1].updated_at;
    oldestSeen = cursor;
    if (batch.length < batchSize) {
      exhausted = true;
      break;
    }
  }
  return { rows, oldestSeen, exhausted };
}

// --- Composite per-member cursor for the team feed merge ---
//
// A single shared timestamp cannot paginate a per-member merge without
// re-serving rows: to avoid skipping anything it must sit at the SLOWEST
// member's scan floor, which forces every other member to be re-scanned from
// that floor on the next page. Live measurement showed 30-70% of every page
// duplicating rows the client already had, and a member's filtered-out band
// (e.g. thousands of subagent sessions) crossing at only maxBatches×batchSize
// raw rows per request — at the bottom of the feed that reads as "load more
// does nothing".
//
// The cursor is therefore a map of per-member resume points: each member
// continues strictly below what THEY already returned, an all-rejected band
// advances at full scan speed, and null marks that member's index truly dry.
// The encoded string stays opaque to the client (persisted and round-tripped
// verbatim). A legacy bare-timestamp cursor is accepted as the same bound for
// every member.

// undefined = scan from the top (new member / fresh pagination); null = done.
export type MemberBound = number | null | undefined;

export function parseFeedCursor(cursor: string | null | undefined): {
  legacy: number | null;
  members: Record<string, MemberBound> | null;
} {
  if (!cursor) return { legacy: null, members: null };
  if (/^\d+$/.test(cursor)) return { legacy: parseInt(cursor, 10), members: null };
  try {
    const parsed = JSON.parse(cursor);
    if (parsed && parsed.v === 2 && parsed.m && typeof parsed.m === "object") {
      return { legacy: null, members: parsed.m };
    }
  } catch {
    // fall through — treat unparseable cursors as a fresh start
  }
  return { legacy: null, members: null };
}

export function encodeFeedCursor(members: Record<string, MemberBound>): string | null {
  const values = Object.values(members);
  // End of history only when EVERY member is explicitly done — an undefined
  // bound (member not yet started / no progress made) still has rows to serve.
  if (values.length > 0 && values.every((v) => v === null)) return null;
  // undefined bounds are omitted (absent key = from the top), null kept as done.
  const m: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(members)) {
    if (v !== undefined) m[k] = v;
  }
  return JSON.stringify({ v: 2, m });
}

export async function paginateTeamFeed(opts: {
  memberIds: string[];
  cursor: string | null;
  limit: number;
  fetchPage: (memberId: string, cursor: number | null, take: number) => Promise<any[]>;
  accept: (c: any) => boolean;
  perMemberFetch: number;
  perMemberWant: number;
  maxBatches?: number;
}): Promise<{ rows: any[]; nextCursor: string | null }> {
  const { memberIds, limit, fetchPage, accept, perMemberFetch, perMemberWant, maxBatches = 4 } = opts;
  const { legacy, members } = parseFeedCursor(opts.cursor);
  const boundOf = (id: string): MemberBound => (members ? members[id] : legacy ?? undefined);

  const scans = await Promise.all(
    memberIds.map(async (id) => {
      const bound = boundOf(id);
      if (bound === null) return { id, bound, rows: [] as any[], oldestSeen: null, exhausted: true };
      const scan = await batchScanConversations({
        fetchPage: (cursor, take) => fetchPage(id, cursor, take),
        startCursor: bound ?? null,
        want: perMemberWant,
        accept,
        batchSize: perMemberFetch,
        maxBatches,
      });
      return { id, bound, ...scan };
    })
  );

  const merged = scans.flatMap((s) => s.rows.map((row) => ({ row, memberId: s.id })));
  merged.sort((a, b) => b.row.updated_at - a.row.updated_at);
  const returned = merged.slice(0, limit);
  const returnedRows = returned.map((r) => r.row);

  // Per-member resume point. Rows a member ACCEPTED but that fell past the
  // page cut were never sent — their member must not advance past them:
  //   • some rows returned → resume below the oldest RETURNED row (re-covers
  //     that member's cut rows AND any unexamined tail of its last batch)
  //   • accepted rows but none returned (all cut) → bound unchanged; those
  //     rows lead the next page
  //   • nothing accepted → the whole examined band was rejected; jump to the
  //     scan floor (full-speed band crossing), or done if the index ran dry
  const nextBounds: Record<string, MemberBound> = {};
  for (const s of scans) {
    if (s.bound === null) {
      nextBounds[s.id] = null;
      continue;
    }
    const returnedOfMember = returned.filter((r) => r.memberId === s.id);
    if (returnedOfMember.length > 0) {
      const oldestReturned = returnedOfMember[returnedOfMember.length - 1].row.updated_at;
      const hasCutRows = s.rows.length > returnedOfMember.length;
      nextBounds[s.id] = s.exhausted && !hasCutRows ? null : oldestReturned;
    } else if (s.rows.length > 0) {
      nextBounds[s.id] = s.bound; // no progress this page; rows lead the next one
    } else {
      nextBounds[s.id] = s.exhausted ? null : s.oldestSeen;
    }
  }

  return { rows: returnedRows, nextCursor: encodeFeedCursor(nextBounds) };
}
