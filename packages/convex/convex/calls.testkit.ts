// Test helpers for the calls mutation tests (calls.test.ts, calls.door.test.ts).

// A tiny fake db shared by the calls mutation tests (same shape as
// callRooms.test.ts): rows per table, eq-only index queries, live patch/delete.
export function fakeCtx() {
  const now = Date.now();
  const rows: Record<string, any[]> = {
    // chat on too: a channel's huddle room opens through the chat room's
    // own door (canAccessChannel), which needs the chat feature.
    teams: [{ _id: "t1", name: "T", features: { calls: true, chat: true } }],
    team_memberships: [
      { _id: "m1", user_id: "ua", team_id: "t1" },
      { _id: "m2", user_id: "ub", team_id: "t1" },
      { _id: "m3", user_id: "uc", team_id: "t1" },
      // ud is on another team entirely
      { _id: "m4", user_id: "ud", team_id: "t2" },
    ],
    users: [
      { _id: "ua", name: "Ann" },
      { _id: "ub", name: "Bob", status: "busy" },
      { _id: "uc", name: "Cy" },
      { _id: "ud", name: "Dee" },
    ],
    call_invites: [],
    call_members: [],
  };
  const inserted: any[] = [];
  const scheduled: any[] = [];
  const ctx: any = {
    auth: { getUserIdentity: async () => ({ subject: "ua|sess", tokenIdentifier: "x" }) },
    scheduler: { runAfter: async (_ms: number, fn: any, args: any) => { scheduled.push({ fn, args }); } },
    db: {
      query: (t: string) => ({
        withIndex: (_i: string, builder: any) => {
          const eqs: Array<[string, any]> = [];
          const gtes: Array<[string, number]> = [];
          builder({
            eq(f: string, v: any) { eqs.push([f, v]); return this; },
            gte(f: string, v: number) { gtes.push([f, v]); return this; },
          });
          const hit = (rows[t] ?? []).filter(
            (r) => eqs.every(([f, v]) => String(r[f]) === String(v)) && gtes.every(([f, v]) => (r[f] ?? 0) >= v),
          );
          return { collect: async () => hit, take: async (n: number) => hit.slice(0, n), unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
        },
      }),
      get: async (id: string) => {
        for (const list of Object.values(rows)) {
          const r = list.find((x) => String(x._id) === String(id));
          if (r) return r;
        }
        return null;
      },
      insert: async (t: string, doc: any) => {
        const _id = `${t}-${(rows[t] ??= []).length + 1}`;
        rows[t].push({ _id, ...doc });
        inserted.push({ t, doc });
        return _id;
      },
      patch: async (id: string, patch: any) => {
        for (const list of Object.values(rows)) {
          const r = list.find((x) => String(x._id) === String(id));
          if (r) Object.assign(r, patch);
        }
      },
      delete: async (id: string) => {
        for (const list of Object.values(rows)) {
          const i = list.findIndex((x) => String(x._id) === String(id));
          if (i >= 0) list.splice(i, 1);
        }
      },
    },
  };
  return { ctx, rows, inserted, scheduled, now };
}
