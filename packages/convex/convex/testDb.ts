// Minimal in-memory ctx.db for bun tests, honoring the .withIndex(name, q =>
// q.eq(field, val)) chains the convex helpers use — so mutation logic is
// testable without the full convex harness. eq() filters apply; range ops
// (gte/gt/lt) are no-ops. insert/patch/delete are tracked AND applied, so a
// test can assert both the call and the resulting row state.
export function makeFakeDb(tables: Record<string, any[]>) {
  const inserted: Array<{ table: string; doc: any; _id: string }> = [];
  const patched: Array<{ _id: any; patch: any }> = [];
  const deleted: any[] = [];
  const db: any = {
    _tables: tables,
    _inserted: inserted,
    _patched: patched,
    _deleted: deleted,
    query(table: string) {
      const filters: Array<[string, any]> = [];
      const apply = () => (tables[table] ?? []).filter((r) => filters.every(([f, v]) => r[f] === v));
      const builder: any = {
        withIndex(_name: string, fn?: (q: any) => any) {
          if (fn) {
            const q: any = {
              eq(field: string, val: any) { filters.push([field, val]); return q; },
              gte() { return q; }, gt() { return q; }, lt() { return q; },
            };
            fn(q);
          }
          return builder;
        },
        filter() { return builder; },
        order() { return builder; },
        async first() { return apply()[0] ?? null; },
        async collect() { return apply(); },
        async take(n: number) { return apply().slice(0, n); },
        // Single-page paginate: all matches, always done. Enough to test logic
        // layered around a paginated scan; cursor mechanics stay untested here.
        async paginate(_opts: any) {
          return { page: apply(), isDone: true, continueCursor: "" };
        },
      };
      return builder;
    },
    async get(id: any) {
      for (const rows of Object.values(tables)) { const r = rows.find((x: any) => x._id === id); if (r) return r; }
      return null;
    },
    async insert(table: string, doc: any) {
      const _id = `${table}_${inserted.length + 1}`;
      (tables[table] ??= []).push({ _id, ...doc });
      inserted.push({ table, doc, _id });
      return _id;
    },
    async patch(id: any, patch: any) {
      patched.push({ _id: id, patch });
      for (const rows of Object.values(tables)) {
        const r = rows.find((x: any) => x._id === id);
        if (r) { Object.assign(r, patch); return; }
      }
    },
    async delete(id: any) {
      deleted.push(id);
      for (const rows of Object.values(tables)) { const i = rows.findIndex((x: any) => x._id === id); if (i >= 0) rows.splice(i, 1); }
    },
  };
  return db;
}
