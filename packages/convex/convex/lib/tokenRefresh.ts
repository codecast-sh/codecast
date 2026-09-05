// Single flight OAuth token refresh, shared by every connector that stores a
// refresh token (oauthConnectors.ts for Linear and Notion, googleOAuth.ts for
// Gmail). docs/architecture/issue-sync.md S5 describes the protocol; this
// module is the protocol, the connectors supply the table and the provider.
//
// Why one module: a provider rotates the refresh token on the first grant
// and refuses the second, so two concurrent refreshes with the same token
// are a lost token, not a harmless duplicate. The lease makes the grant
// single flight; the fenced outcome write makes a late finish harmless.

/** Refresh this far ahead of expiry so an in-flight call never straddles it. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** How long one caller may hold the refresh; long enough for a slow token
 *  endpoint, short enough that a crashed claimant does not block a team. */
export const REFRESH_LEASE_MS = 30 * 1000;
/** How long a waiter watches for the claimant's write before trying itself. */
export const REFRESH_WAIT_MS = 15 * 1000;
export const REFRESH_POLL_MS = 250;

/** Absolute expiry from a token response, or undefined when the provider
 *  gave no expires_in (Notion: tokens do not expire). */
export function accessExpiresAt(tok: any, now: number): number | undefined {
  return typeof tok?.expires_in === "number" && tok.expires_in > 0 ? now + tok.expires_in * 1000 : undefined;
}

/** The credential fields every connector row carries for this protocol. */
export type RefreshRow = {
  _id: any;
  access_token_enc?: string;
  refresh_token_enc?: string;
  access_expires_at?: number;
  refresh_lease_id?: string;
  refresh_lease_until?: number;
};

/** A row refreshes when it CAN (has a refresh token) and its access token is
 *  expiring, expired, or of unknown age. Rows without a refresh token never
 *  refresh: their access token is the only credential there is. */
export function needsRefresh(row: { refresh_token_enc?: string; access_expires_at?: number }, now: number): boolean {
  if (!row.refresh_token_enc) return false;
  if (row.access_expires_at === undefined) return true;
  return row.access_expires_at - now < REFRESH_MARGIN_MS;
}

/** The credential identity a claimant or writer proves it read: BOTH
 *  ciphertexts. Every refresh rewrites the access one and every reconnect
 *  rewrites the refresh one (random IV even for the same plaintext), so any
 *  change to either credential changes the stamp. The access ciphertext
 *  alone was not enough: a legacy or just-reconnected row has none, and a
 *  reconnect that only replaced the refresh grant was invisible to a stale
 *  claim, which then refreshed the OLD grant over the new connection. */
export const stampOf = (row: { access_token_enc?: string; refresh_token_enc?: string }) =>
  `${row.access_token_enc ?? ""}|${row.refresh_token_enc ?? ""}`;

/** Per table options for the mutation bodies. */
export type StampOptions = {
  /**
   * Transition compatibility for ONE table, remove in the release after this
   * one ships: an action that started under the previous protocol (the
   * released Linear action in flight at the moment of deploy) carries the
   * access ciphertext alone. Only the Linear wrapper turns this on, because
   * only there is a non-empty access ciphertext unique per refresh and per
   * reconnect (Linear reconnects always cache one), so the legacy form still
   * proves the credentials read are the credentials held. The empty legacy
   * stamp (a row without cache, the pre-claim hole) never matches. The
   * generic path, and Gmail, accept the two-ciphertext form only.
   */
  acceptLegacyAccessStamp?: boolean;
};

/** Does the stamp a caller read still describe this row? */
export function stampMatches(
  row: { access_token_enc?: string; refresh_token_enc?: string },
  expected: string,
  opts: StampOptions = {},
): boolean {
  if (expected === stampOf(row)) return true;
  if (!opts.acceptLegacyAccessStamp) return false;
  const legacyAccessOnly = expected !== "" && !expected.includes("|");
  return legacyAccessOnly && expected === (row.access_token_enc ?? "");
}

export type ClaimResult = { ok: boolean; lease?: string; reason?: "gone" | "superseded" | "held" };
export type OutcomeArgs = {
  /** stampOf(row) as the writer read it. */
  expected_enc: string;
  lease: string;
  access_token_enc?: string;
  refresh_token_enc?: string;
  access_expires_at?: number;
  last_error?: string;
};
export type WriteResult = { ok: boolean; reason?: "gone" | "superseded" };

/**
 * Mutation body: claim the refresh for one row. Every concurrent caller that
 * finds the token expiring lands here; exactly one gets `ok` and a lease id,
 * the rest are told the refresh is `held` and wait for the credentials to
 * change. The claim is also a compare and swap on the stamp, so a caller
 * holding a stale read cannot claim over credentials that already moved on.
 */
export async function claimRefreshOn(db: any, id: any, expectedEnc: string, now: number, opts: StampOptions = {}): Promise<ClaimResult> {
  const row = await db.get(id);
  if (!row) return { ok: false, reason: "gone" };
  if (!stampMatches(row, expectedEnc, opts)) return { ok: false, reason: "superseded" };
  if (typeof row.refresh_lease_until === "number" && row.refresh_lease_until > now) return { ok: false, reason: "held" };
  const lease = crypto.randomUUID();
  await db.patch(id, { refresh_lease_id: lease, refresh_lease_until: now + REFRESH_LEASE_MS });
  return { ok: true, lease };
}

/**
 * Mutation body: persist the outcome of one refresh. Both outcomes are
 * fenced the same way: the writer must still own the lease it claimed AND
 * the credentials must be the ones it read. Nothing about the order in
 * which provider responses arrive says whose pair is newer, so an expired
 * claimant's late success is refused like its late failure would be. A
 * reconnect clears the lease and rewrites the stamp, so anything in flight
 * before it is refused on both counts. A deleted row is reported, never
 * recreated. The one write that passes releases the lease.
 */
export async function writeRefreshOutcomeOn(db: any, id: any, args: OutcomeArgs, opts: StampOptions = {}): Promise<WriteResult> {
  const row = await db.get(id);
  if (!row) return { ok: false, reason: "gone" };
  if (row.refresh_lease_id !== args.lease || !stampMatches(row, args.expected_enc, opts)) return { ok: false, reason: "superseded" };
  const release = { refresh_lease_id: undefined, refresh_lease_until: undefined, updated_at: Date.now() };
  if (args.access_token_enc) {
    await db.patch(id, {
      ...release,
      access_token_enc: args.access_token_enc,
      access_expires_at: args.access_expires_at,
      last_error: undefined,
      ...(args.refresh_token_enc ? { refresh_token_enc: args.refresh_token_enc } : {}),
    });
    return { ok: true };
  }
  await db.patch(id, { ...release, last_error: args.last_error });
  return { ok: true };
}

export type RefreshResult = { ok: boolean; token?: string; expires_at?: number; error?: string };

export type RefreshDeps = {
  /** Provider name for messages ("Linear", "Gmail"). */
  provider: string;
  /** The row as it is now; null when disconnected or still pending. */
  read: () => Promise<RefreshRow | null>;
  claim: (id: any, expectedEnc: string, now: number) => Promise<ClaimResult>;
  write: (id: any, args: OutcomeArgs) => Promise<WriteResult>;
  decrypt: (enc: string) => Promise<string | null>;
  encrypt: (plain: string) => Promise<string>;
  /** One refresh grant at the provider's token endpoint. */
  request: (refreshToken: string) => Promise<{ ok: boolean; status: number; tok: any }>;
  /** Refresh even if the recorded expiry says the token is fresh. */
  force?: boolean;
  errors: { noConnection: string; undecryptable: string; reconnect: string };
  /** Internal: one retry after deferring to an owner that left no cached token. */
  _retried?: boolean;
};

/**
 * The access token for one connection, refreshed when it is expiring or of
 * unknown age. A refusal is returned, not thrown, so callers can say
 * "reconnect" instead of "401".
 *
 * One caller claims the lease and talks to the provider; the others wait
 * for the row to change and return the pair that landed. Every outcome
 * write is fenced by lease ownership and credential compare and swap; when
 * a write is refused the caller waits for the current owner's write and
 * returns what the row holds then, never the pair it fetched: a
 * disconnected connection yields no credentials, a superseded refresh
 * yields the owner's.
 */
export async function singleFlightRefresh(deps: RefreshDeps): Promise<RefreshResult> {
  const noConnection: RefreshResult = { ok: false, error: deps.errors.noConnection };
  const tokenOf = async (row: RefreshRow): Promise<RefreshResult> => {
    const token = row.access_token_enc ? await deps.decrypt(row.access_token_enc) : null;
    return token ? { ok: true, token, expires_at: row.access_expires_at } : { ok: false, error: deps.errors.undecryptable };
  };
  /** Wait for another claimant's write. Resolves with the new credentials,
   *  or null once the lease lapsed with nothing written. */
  const waitForOther = async (seenEnc: string): Promise<RefreshResult | null> => {
    const deadline = Date.now() + REFRESH_WAIT_MS;
    while (Date.now() < deadline) {
      const row = await deps.read();
      if (!row) return noConnection;
      // The credentials changed: a claimant wrote a pair (use it), or a
      // reconnect replaced the grant without caching a token yet (nothing
      // landed to use; the caller refreshes on the new grant).
      if (stampOf(row) !== seenEnc) return row.access_token_enc ? await tokenOf(row) : null;
      if (typeof row.refresh_lease_until !== "number" || row.refresh_lease_until <= Date.now()) return null;
      await new Promise((r) => setTimeout(r, REFRESH_POLL_MS));
    }
    return null;
  };

  let row = await deps.read();
  if (!row) return noConnection;
  const now = Date.now();
  if (!deps.force && !needsRefresh(row, now)) return await tokenOf(row);

  // Claim, or wait for whoever holds the claim.
  let lease: string | undefined;
  for (let attempt = 0; attempt < 3 && !lease; attempt++) {
    const claim = await deps.claim(row._id, stampOf(row), Date.now());
    if (claim.ok) { lease = claim.lease; break; }
    if (claim.reason === "gone") return noConnection;
    const landed = await waitForOther(stampOf(row));
    if (landed) return landed;
    const again = await deps.read();
    if (!again) return noConnection;
    row = again;
    if (!needsRefresh(row, Date.now())) return await tokenOf(row);
  }
  if (!lease) return { ok: false, error: `${deps.provider} refresh is held by another caller; retry` };
  const mine = row;
  const stamp = stampOf(mine);

  /** A refused write means the row is no longer ours: a reconnect landed or
   *  a newer claimant holds the lease. Their write is the answer, so wait
   *  for it; the pair we fetched is never handed out. */
  const deferToOwner = async (reason: WriteResult["reason"]): Promise<RefreshResult> => {
    if (reason === "gone") return noConnection;
    const landed = await waitForOther(stamp);
    if (landed) return landed;
    // Nobody is refreshing and the row holds a refresh token but no cached
    // access token (a reconnect just replaced the grant): refresh once more
    // on the new grant instead of reporting the old one as undecryptable.
    const latest = await deps.read();
    if (!latest) return noConnection;
    if (!latest.access_token_enc && latest.refresh_token_enc && !deps._retried) {
      return await singleFlightRefresh({ ...deps, force: false, _retried: true });
    }
    return await tokenOf(latest);
  };

  const refreshToken = mine.refresh_token_enc ? await deps.decrypt(mine.refresh_token_enc) : null;
  if (!refreshToken) {
    // No refresh token (or undecryptable): the access token is all we have.
    // Releasing the lease is an outcome write like any other, so a reconnect
    // or disconnect that landed meanwhile refuses it.
    const released = await deps.write(mine._id, { expected_enc: stamp, lease });
    if (!released.ok) return await deferToOwner(released.reason);
    return mine.access_token_enc ? await tokenOf(mine) : { ok: false, error: deps.errors.undecryptable };
  }
  const fail = async (error: string) => {
    const stamped = await deps.write(mine._id, { expected_enc: stamp, lease: lease!, last_error: error });
    return stamped.ok ? { ok: false, error } : await deferToOwner(stamped.reason);
  };
  let res: { ok: boolean; status: number; tok: any };
  try {
    res = await deps.request(refreshToken);
  } catch {
    return await fail(`${deps.provider} token endpoint unreachable; the next call retries`);
  }
  const tok = res.tok;
  if (!res.ok || typeof tok?.access_token !== "string") {
    const code = tok?.error ?? `token_${res.status}`;
    const revoked = code === "invalid_grant" || res.status === 400 || res.status === 401;
    return await fail(
      revoked
        ? `${deps.provider} refresh refused (${code}): access was revoked or the refresh token expired; ${deps.errors.reconnect}`
        : `${deps.provider} refresh failed (${code}); the next call retries`,
    );
  }
  const expiresAt = accessExpiresAt(tok, now);
  const written = await deps.write(mine._id, {
    expected_enc: stamp,
    lease,
    access_token_enc: await deps.encrypt(tok.access_token),
    refresh_token_enc: typeof tok.refresh_token === "string" ? await deps.encrypt(tok.refresh_token) : undefined,
    access_expires_at: expiresAt,
  });
  return written.ok ? { ok: true, token: tok.access_token, expires_at: expiresAt } : await deferToOwner(written.reason);
}
