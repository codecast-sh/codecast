// Shared fixtures for the inbox projection tests (conversations.projection.test.ts
// and conversations.liveDerivation.test.ts). A .testkit.ts name keeps the Convex
// bundler from deploying it.
import { inboxEpoch } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";

export const ME = "users_me";
export const MIN = 60 * 1000;
export const H = 60 * MIN;
// Twenty-five seconds into a minute, so the epoch (the placement clock) and
// as_of (the execution clock) differ and the tests can tell them apart.
export const NOW = 1_800_000_000_000 + 25_000;
export const EPOCH = inboxEpoch(NOW);

export const LIVENESS_FIELDS = ["agent_status", "is_idle", "awaiting_input"];

export function conv(id: string, overrides: Record<string, any> = {}) {
  return {
    _id: `conversations_${id}`,
    user_id: ME,
    status: "active",
    updated_at: EPOCH - 2 * H,
    started_at: EPOCH - 3 * H,
    message_count: 4,
    last_message_role: "assistant",
    title: `Session ${id}`,
    ...overrides,
  };
}

export function db(tables: Record<string, any[]>) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@example.com" }],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    session_decisions: [],
    decision_inbox: [],
    ...tables,
  });
}

// Every db read, by table (plus the index name for queries): what an execution costs.
export function countingCtx(fake: any) {
  const ops: string[] = [];
  const origQuery = fake.query.bind(fake);
  const origGet = fake.get.bind(fake);
  fake.query = (table: string) => {
    const b = origQuery(table);
    const origWithIndex = b.withIndex.bind(b);
    b.withIndex = (name: string, fn?: any) => { ops.push(`${table}.${name}`); return origWithIndex(name, fn); };
    return b;
  };
  fake.get = (id: any) => { ops.push("get"); return origGet(id); };
  return { ctx: { db: fake }, ops };
}

