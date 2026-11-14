import type Dexie from "dexie";
import { authPrincipal } from "../lib/authPrincipal";
import { recordCacheEvent } from "./cacheEvents";

// -- Cache ownership --
//
// The cache belongs to ONE account. Two rows on disk say which:
//   • the owner stamp (OWNER_STAMP_KEY), written straight through by the
//     ownership check whenever it confirms or establishes an owner, and after
//     every purge: the principal kept, or a signed-out tombstone (null) when
//     the purge was leaving an account;
//   • the server-confirmed user row (meta.currentUser), only ever written
//     from getCurrentUser results.
// Hydration serves the cache only when that evidence names the principal the
// stored JWT names, and nothing names anyone else. Writes are bound to the
// principal that resolved here and refuse the moment the stored JWT names
// someone else, which closes the gap between a sibling's sign-out and this
// window's storage event.
//
// A purge needs a reason the disk proves: another named owner, residue
// written after a sign-out (the tombstone), nobody signed in, or rows that
// name no owner at all. That last one survives because the dispatch outbox
// holds server writes, and an outbox nobody can be shown to own must never be
// replayed as the signed-in account; with the stamp written on every boot it
// arises only from a store the browser lost or a cache from before stamps,
// where little is left to lose. A disk that cannot be READ is never a reason:
// it serves nothing and purges nothing (a transient read error once could
// wipe a healthy cache). Every purge and every refusal is recorded
// (store/cacheEvents.ts).

const OWNER_STAMP_KEY = "cacheOwner";
type OwnerStamp = { principal: string | null; at: number; reason: string };

export type CacheOwnershipDeps = {
  db: Dexie & { meta: Dexie.Table<{ key: string; value: any }, string> };
  sessions: Dexie.Table<any, string> | undefined;
  pendingInputPrefix: string;
  purge: (opts: { keepPendingInputFor: string | null; reason: string; detail: Record<string, unknown> }) => Promise<void>;
  onServed: () => void;
};

export function createCacheOwnership(deps: CacheOwnershipDeps) {
  let ownership: Promise<string | null> | null = null;
  let boundOwner: string | null = null;

  // The owner rows, read in one transaction. `stamp` is undefined when there is
  // no stamp row and null for a signed-out tombstone.
  async function readOwnerEvidence(): Promise<{ stamp: string | null | undefined; user: string | null }> {
    return deps.db.transaction("r", deps.db.meta, async () => {
      const [stampRow, userRow] = await Promise.all([deps.db.meta.get(OWNER_STAMP_KEY), deps.db.meta.get("currentUser")]);
      const stampValue = stampRow?.value as OwnerStamp | undefined;
      const stamp = stampValue === undefined ? undefined
        : typeof stampValue?.principal === "string" ? stampValue.principal : null;
      const id = userRow?.value?._id;
      return { stamp, user: typeof id === "string" ? id : null };
    });
  }

  async function writeOwnerStamp(principal: string | null, reason: string): Promise<void> {
    try {
      await deps.db.meta.put({ key: OWNER_STAMP_KEY, value: { principal, at: Date.now(), reason } satisfies OwnerStamp });
    } catch (error) {
      recordCacheEvent("ownership-unreadable", { step: "write-stamp", reason, error: String(error) });
    }
  }

  // Rows on disk that are not the principal's own pending input or the owner
  // stamp, or null when they cannot be counted. Pending input is keyed by its
  // owner (pendingInputKey), so a principal's typed-but-unsent messages are
  // theirs whoever the rest of the cache belongs to, and a cache holding
  // nothing else is a fresh cache with their journal in it. The outbox is not
  // counted (as before stamps): a window's own first write can land before its
  // ownership resolves. One transaction for every count: separate reads could
  // straddle a write and count a row twice.
  async function foreignRowCount(principal: string | null): Promise<number | null> {
    try {
      const sessions = deps.sessions;
      // Index-only counts (no row values are read; meta holds large blobs), in
      // one read transaction so all of them see the same snapshot.
      return await deps.db.transaction("r", sessions ? [deps.db.meta, sessions] : [deps.db.meta], async () => {
        const meta = await deps.db.meta.count();
        const own = principal ? await deps.db.meta.where("key").startsWith(`${deps.pendingInputPrefix}${principal}:`).count() : 0;
        const stamp = await deps.db.meta.where("key").equals(OWNER_STAMP_KEY).count();
        const rows = sessions ? await sessions.count() : 0;
        return meta - own - stamp + rows;
      });
    } catch {
      return null;
    }
  }

  // Disk ownership is decided by the disk alone. A caller's own idea of who is
  // signed in proves nothing about rows written by an earlier account, so it is
  // never consulted here.
  async function resolveCacheOwnership(): Promise<string | null> {
    const principal = await authPrincipal.resolve();
    boundOwner = principal;
    let evidence: Awaited<ReturnType<typeof readOwnerEvidence>>;
    try {
      evidence = await readOwnerEvidence();
    } catch (error) {
      recordCacheEvent("ownership-unreadable", { step: "read-owner", principal, error: String(error) });
      return null;
    }
    const named = [evidence.stamp, evidence.user].filter((p): p is string => typeof p === "string");
    const others = named.filter((p) => p !== principal);
    if (principal !== null && named.length > 0 && others.length === 0) {
      if (evidence.stamp !== principal) await writeOwnerStamp(principal, "confirmed");
      deps.onServed();
      return principal;
    }
    // A stored token that does not parse, or a durable tier that could not be
    // read, is not a sign-out: the tracker keeps the account it last knew
    // (served above when it owns the cache), and with no account known nothing
    // is served. Nothing is purged either way; the cache is destroyed only by
    // an explicit sign-out or by a change to another named account.
    const tokenState = authPrincipal.tokenState();
    if (tokenState === "unparsable" || tokenState === "unreadable") {
      console.warn(`[cache] the stored token is ${tokenState}; keeping the cache as it is`);
      return null;
    }
    const foreign = await foreignRowCount(principal);
    if (foreign === null) {
      recordCacheEvent("ownership-unreadable", { step: "count-rows", principal });
      return null;
    }
    if (foreign === 0) {
      // Nothing on disk but the principal's own pending input: a fresh cache.
      if (principal !== null) await writeOwnerStamp(principal, "fresh");
      return null;
    }
    const reason = others.length > 0 ? "another-owner"
      : principal === null ? "signed-out"
      : evidence.stamp === null ? "signed-out-residue"
      : "no-owner-recorded";
    const detail = { reason, principal, stamp: evidence.stamp === undefined ? "absent" : evidence.stamp ?? "signed-out", user: evidence.user, foreignRows: foreign, tokenState };
    await deps.purge({ keepPendingInputFor: principal, reason, detail });
    return null;
  }

  /** The principal the disk cache may be served to, or null when it must not be
   *  read. Resolved per read (two cheap lookups); concurrent reads share one. */
  function ensureCacheOwnership(): Promise<string | null> {
    if (!ownership) ownership = resolveCacheOwnership().finally(() => { ownership = null; });
    return ownership;
  }

  /** Writes land only for the account the stored JWT names, and, once hydration
   *  resolved the cache's owner, only while that is still the same account. */
  function persistenceOwned(): boolean {
    const principal = authPrincipal.current();
    return principal !== null && (boundOwner === null || boundOwner === principal);
  }

  // Test hook: the account a fresh process resolves for, without a full boot.
  function _cacheOwnerForTests(): string | null {
    return boundOwner;
  }
  return { ensureCacheOwnership, persistenceOwned, writeOwnerStamp, _cacheOwnerForTests };
}
