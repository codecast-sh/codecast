import { describe, expect, test } from "bun:test";
import {
  CLI_AUTH_TTL_MS,
  claimCliAuthRequest,
  sweepExpiredCliAuthRequests,
} from "./cliAuth";
import { hashToken } from "./apiTokens";

// Minimal in-memory ctx.db honoring the .withIndex(name, q => q.eq/lt(...))
// chains cliAuth uses (same approach as cleanup.test.ts), so claim/sweep are
// testable without the full convex harness.
function makeFakeDb(tables: Record<string, any[]>) {
  const deleted: any[] = [];
  let nextId = 1;
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      row._id = row._id ?? `${table}:${nextId++}`;
    }
  }
  const isLive = (table: string, row: any) =>
    !deleted.includes(row._id) && (tables[table] ?? []).includes(row);
  const db: any = {
    _deleted: deleted,
    query(table: string) {
      const preds: Array<(r: any) => boolean> = [];
      const apply = () => (tables[table] ?? []).filter((r) => isLive(table, r) && preds.every((p) => p(r)));
      const builder: any = {
        withIndex(_name: string, fn?: (q: any) => any) {
          if (fn) {
            const q: any = {
              eq(field: string, val: any) { preds.push((r) => r[field] === val); return q; },
              lt(field: string, val: any) { preds.push((r) => r[field] < val); return q; },
              gt(field: string, val: any) { preds.push((r) => r[field] > val); return q; },
              gte(field: string, val: any) { preds.push((r) => r[field] >= val); return q; },
            };
            fn(q);
          }
          return builder;
        },
        async first() { return apply()[0] ?? null; },
        async collect() { return apply(); },
        async take(n: number) { return apply().slice(0, n); },
      };
      return builder;
    },
    async delete(id: any) { deleted.push(id); },
  };
  return db;
}

const NONCE = "a".repeat(64);
const TOKEN = "b".repeat(64);

async function seededDb(opts: { createdAt: number; withApiToken?: boolean }) {
  const relayRow = {
    nonce_hash: await hashToken(NONCE),
    user_id: "users:1",
    token: TOKEN,
    device_name: "remote-mini",
    created_at: opts.createdAt,
  };
  const apiTokenRow = {
    user_id: "users:1",
    token_hash: await hashToken(TOKEN),
    name: "remote-mini",
    created_at: opts.createdAt,
    last_used_at: opts.createdAt,
  };
  return makeFakeDb({
    cli_auth_requests: [relayRow],
    api_tokens: opts.withApiToken === false ? [] : [apiTokenRow],
  });
}

describe("claimCliAuthRequest", () => {
  test("returns credentials and deletes the row on first claim", async () => {
    const now = Date.now();
    const db = await seededDb({ createdAt: now });

    const result = await claimCliAuthRequest({ db }, NONCE, now);
    expect(result).toEqual({ user_id: "users:1", auth_token: TOKEN });
    expect(db._deleted.length).toBe(1);

    const again = await claimCliAuthRequest({ db }, NONCE, now);
    expect(again).toBeNull();
  });

  test("returns null for an unknown nonce", async () => {
    const db = makeFakeDb({ cli_auth_requests: [], api_tokens: [] });
    expect(await claimCliAuthRequest({ db }, NONCE)).toBeNull();
  });

  test("expired deposit is not claimable, and the row still dies", async () => {
    const now = Date.now();
    const db = await seededDb({ createdAt: now - CLI_AUTH_TTL_MS - 1 });

    expect(await claimCliAuthRequest({ db }, NONCE, now)).toBeNull();
    expect(db._deleted.length).toBe(1);
  });
});

describe("sweepExpiredCliAuthRequests", () => {
  test("deletes expired rows and revokes their orphaned api_tokens", async () => {
    const now = Date.now();
    const db = await seededDb({ createdAt: now - CLI_AUTH_TTL_MS - 1 });

    const swept = await sweepExpiredCliAuthRequests({ db }, now);
    expect(swept).toBe(1);
    // Both the relay row and the never-delivered token are gone.
    expect(db._deleted.length).toBe(2);
  });

  test("leaves fresh rows alone", async () => {
    const now = Date.now();
    const db = await seededDb({ createdAt: now - 1000 });

    expect(await sweepExpiredCliAuthRequests({ db }, now)).toBe(0);
    expect(db._deleted.length).toBe(0);
  });

  test("tolerates an already-revoked token", async () => {
    const now = Date.now();
    const db = await seededDb({ createdAt: now - CLI_AUTH_TTL_MS - 1, withApiToken: false });

    expect(await sweepExpiredCliAuthRequests({ db }, now)).toBe(1);
    expect(db._deleted.length).toBe(1);
  });
});
