// ── In-memory Convex-ish ctx ─────────────────────────────────────────────────
// Same pattern as pendingMessages.teamSend.test.ts: a fake `ctx.db` faithful
// enough to run the REAL needs-input check end-to-end. withIndex ignores the
// index NAME and matches on the eq constraints; order("desc") sorts by
// `timestamp` (the only ordered read the check makes is the messages tail).
// scheduler.runAfter records calls so tests can assert on pushes/summaries.

export type Rec = Record<string, any>;

export function createCtx(seed: Record<string, Rec[]>) {
  const tables: Record<string, Rec[]> = {};
  const counters: Record<string, number> = {};
  for (const [table, rows] of Object.entries(seed)) {
    tables[table] = rows.map((r) => ({ ...r }));
  }
  const allRows = () => Object.values(tables).flat();

  const db = {
    async get(id: string) {
      return allRows().find((r) => r._id === id) ?? null;
    },
    async insert(table: string, doc: Rec) {
      counters[table] = (counters[table] ?? 0) + 1;
      const _id = `${table}_${counters[table]}`;
      (tables[table] ??= []).push({ _id, ...doc });
      return _id;
    },
    async patch(id: string, patch: Rec) {
      const row = allRows().find((r) => r._id === id);
      if (!row) throw new Error(`patch: no row ${id}`);
      Object.assign(row, patch);
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((r) => r._id === id);
        if (i !== -1) {
          rows.splice(i, 1);
          return;
        }
      }
      throw new Error(`delete: no row ${id}`);
    },
    query(table: string) {
      const constraints: Array<{ field: string; val: any }> = [];
      // Range arms of an index read (the digest flush asks for rows created
      // since the window opened).
      const ranges: Array<(r: Rec) => boolean> = [];
      const q: any = {
        eq(field: string, val: any) {
          constraints.push({ field, val });
          return q;
        },
        gte(field: string, val: any) {
          ranges.push((r) => (r[field] ?? 0) >= val);
          return q;
        },
        gt(field: string, val: any) {
          ranges.push((r) => (r[field] ?? 0) > val);
          return q;
        },
      };
      let desc = false;
      // .filter(q => q.eq(q.field("role"), "user")) — the one filter shape the
      // check uses. field() returns a marker resolved per row at run time.
      const rowPredicates: Array<(r: Rec) => boolean> = [];
      const filterQ = {
        field: (name: string) => ({ __field: name }),
        eq: (a: any, b: any) => ({ __eq: [a, b] }),
      };
      const resolveOperand = (r: Rec, x: any) =>
        x && typeof x === "object" && "__field" in x ? r[x.__field] : x;
      const run = () => {
        const rows = (tables[table] ?? []).filter(
          (r) =>
            constraints.every((c) => String(r[c.field]) === String(c.val)) &&
            ranges.every((p) => p(r)) &&
            rowPredicates.every((p) => p(r))
        );
        if (desc) rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        return rows;
      };
      const chain: any = {
        withIndex(_name: string, builder?: (q: any) => unknown) {
          if (builder) builder(q);
          return chain;
        },
        filter(builder: (fq: any) => any) {
          const expr = builder(filterQ);
          rowPredicates.push((r) => {
            const [a, b] = expr.__eq;
            return String(resolveOperand(r, a)) === String(resolveOperand(r, b));
          });
          return chain;
        },
        order(dir: string) {
          desc = dir === "desc";
          return chain;
        },
        async collect() {
          return run();
        },
        async first() {
          return run()[0] ?? null;
        },
        async unique() {
          return run()[0] ?? null;
        },
        async take(n: number) {
          return run().slice(0, n);
        },
      };
      return chain;
    },
  };

  const scheduled: Array<{ delay: number; args: Rec }> = [];
  const scheduler = {
    async runAfter(delay: number, _fn: unknown, args: Rec) {
      scheduled.push({ delay, args });
    },
  };

  return { ctx: { db, scheduler }, tables, scheduled };
}

// A session that finished a turn and settled past the idle grace: the daemon
// flipped agent_status to "idle" 60s ago (grace is 45s), the last synced
// message is the assistant's answer, heartbeat fresh. This is the exact state
// the web inbox files under NEEDS YOU and chimes for.
export function settledIdleWorld(overrides: {
  conv?: Rec;
  session?: Rec;
  users?: Rec[];
  messages?: Rec[];
  extra?: Record<string, Rec[]>;
} = {}) {
  const now = Date.now();
  return createCtx({
    users: overrides.users ?? [
      { _id: "u1", notifications_enabled: true, push_token: "tok-u1" },
    ],
    conversations: [
      {
        _id: "conv1",
        user_id: "u1",
        title: "Fix the parser",
        status: "active",
        message_count: 5,
        updated_at: now - 120_000,
        last_message_role: "assistant",
        ...(overrides.conv ?? {}),
      },
    ],
    managed_sessions: [
      {
        _id: "ms1",
        user_id: "u1",
        conversation_id: "conv1",
        session_id: "sess-1",
        agent_status: "idle",
        agent_status_updated_at: now - 60_000,
        last_heartbeat: now - 5_000,
        ...(overrides.session ?? {}),
      },
    ],
    messages: overrides.messages ?? [
      {
        _id: "m1",
        conversation_id: "conv1",
        role: "assistant",
        content: "Done — the parser handles nested arrays now. What next?",
        timestamp: now - 70_000,
      },
    ],
    pending_permissions: [],
    notifications: [],
    ...(overrides.extra ?? {}),
  });
}
