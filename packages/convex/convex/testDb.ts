// Minimal in-memory ctx.db for bun tests, honoring the .withIndex(name, q =>
// q.eq(field, val)) chains the convex helpers use — so mutation logic is
// testable without the full convex harness. eq() filters apply; range ops
// (gte/gt/lt) are no-ops. insert/patch/delete are tracked AND applied, so a
// test can assert both the call and the resulting row state.
//
// `order("desc")` and `.filter()` are REAL, because several code paths mean the
// opposite thing without them: "the newest message in this thread" reads the
// oldest under a no-op order, and "roots only"
// (filter(q.eq(q.field("thread_root_id"), undefined))) reads replies too. A
// harness that silently inverts the question under test passes whatever it is
// given.
type FilterExpr =
  | { kind: "field"; name: string }
  | { kind: "literal"; value: any }
  | { kind: "op"; op: string; args: FilterExpr[] };

function evalFilter(expr: FilterExpr, row: any): any {
  if (expr.kind === "field") return row[expr.name];
  if (expr.kind === "literal") return expr.value;
  const a = expr.args.map((arg) => evalFilter(arg, row));
  switch (expr.op) {
    case "eq": return a[0] === a[1];
    case "neq": return a[0] !== a[1];
    case "lt": return a[0] < a[1];
    case "lte": return a[0] <= a[1];
    case "gt": return a[0] > a[1];
    case "gte": return a[0] >= a[1];
    case "and": return a.every(Boolean);
    case "or": return a.some(Boolean);
    case "not": return !a[0];
    default: throw new Error(`fake db: unsupported filter op ${expr.op}`);
  }
}

const filterBuilder = {
  field: (name: string): FilterExpr => ({ kind: "field", name }),
  eq: (l: any, r: any): FilterExpr => op("eq", l, r),
  neq: (l: any, r: any): FilterExpr => op("neq", l, r),
  lt: (l: any, r: any): FilterExpr => op("lt", l, r),
  lte: (l: any, r: any): FilterExpr => op("lte", l, r),
  gt: (l: any, r: any): FilterExpr => op("gt", l, r),
  gte: (l: any, r: any): FilterExpr => op("gte", l, r),
  and: (...args: any[]): FilterExpr => op("and", ...args),
  or: (...args: any[]): FilterExpr => op("or", ...args),
  not: (arg: any): FilterExpr => op("not", arg),
};

function op(name: string, ...args: any[]): FilterExpr {
  return {
    kind: "op",
    op: name,
    args: args.map((arg) =>
      arg && typeof arg === "object" && "kind" in arg
        ? (arg as FilterExpr)
        : ({ kind: "literal", value: arg } as FilterExpr)),
  };
}

export function makeFakeDb(tables: Record<string, any[]>) {
  const inserted: Array<{ table: string; doc: any; _id: string }> = [];
  const patched: Array<{ _id: any; patch: any }> = [];
  const replaced: Array<{ _id: any; doc: any }> = [];
  const deleted: any[] = [];
  const db: any = {
    _tables: tables,
    _inserted: inserted,
    _patched: patched,
    _replaced: replaced,
    _deleted: deleted,
    query(table: string) {
      const filters: Array<[string, any]> = [];
      // A search index is an eq-filter chain plus one substring term — enough to
      // test the scoping and shaping around a text search, not the ranking.
      let search: [string, string] | null = null;
      // Unset until the caller asks. An unordered query keeps insertion order,
      // which is what every test written before ordering existed assumes.
      let direction: "asc" | "desc" | null = null;
      const predicates: FilterExpr[] = [];
      // Every time-ordered index in this schema is keyed on one of these, so
      // ordering by it is what `order()` means here. Rows without one keep
      // insertion order (the sort is stable). `last_activity_at` comes first:
      // the tables that have it (thread_reads) index on it, and their
      // `updated_at` moves on every mark-read — ordering by that would shuffle
      // the Threads inbox whenever a row was touched.
      const timeKey = (row: any) =>
        row.last_activity_at ?? row.created_at ?? row.timestamp ?? row.updated_at ?? null;
      const apply = () => {
        const rows = (tables[table] ?? [])
          .filter((r) => filters.every(([f, v]) => r[f] === v))
          .filter((r) => predicates.every((p) => !!evalFilter(p, r)))
          .filter((r) => !search
            || String(r[search[0]] ?? "").toLowerCase().includes(search[1].toLowerCase()));
        if (!direction) return rows;
        const sign = direction === "desc" ? -1 : 1;
        // Ties break on insertion order, the way a real index breaks them on
        // `_id`. Rows written inside one millisecond are the common case in a
        // test, and without this "the newest reply" would be whichever row the
        // seed happened to list first.
        const indexed = rows.map((row, i) => [row, i] as const);
        indexed.sort(([a, ia], [b, ib]) => {
          const ka = timeKey(a);
          const kb = timeKey(b);
          if (ka !== null && kb !== null && ka !== kb) return ka < kb ? -sign : sign;
          return (ia - ib) * sign;
        });
        return indexed.map(([row]) => row);
      };
      const builder: any = {
        withIndex(_name: string, fn?: (q: any) => any) {
          if (fn) {
            // Range bounds are REAL. "Everything since your read mark" and
            // "everything before this page" are the whole meaning of the queries
            // that use them, and a no-op bound answers a different question —
            // one where the unread count is the channel's entire history.
            const q: any = {
              eq(field: string, val: any) { filters.push([field, val]); return q; },
              gte(f: string, v: any) { predicates.push(op("gte", filterBuilder.field(f), v)); return q; },
              gt(f: string, v: any) { predicates.push(op("gt", filterBuilder.field(f), v)); return q; },
              lte(f: string, v: any) { predicates.push(op("lte", filterBuilder.field(f), v)); return q; },
              lt(f: string, v: any) { predicates.push(op("lt", filterBuilder.field(f), v)); return q; },
            };
            fn(q);
          }
          return builder;
        },
        withSearchIndex(_name: string, fn?: (q: any) => any) {
          if (fn) {
            const q: any = {
              search(field: string, text: string) { search = [field, text]; return q; },
              eq(field: string, val: any) { filters.push([field, val]); return q; },
            };
            fn(q);
          }
          return builder;
        },
        filter(fn?: (q: any) => any) {
          if (fn) predicates.push(fn(filterBuilder));
          return builder;
        },
        order(dir?: string) {
          direction = dir === "desc" ? "desc" : "asc";
          return builder;
        },
        async first() { return apply()[0] ?? null; },
        async unique() {
          const rows = apply();
          if (rows.length > 1) throw new Error("Query returned more than one result");
          return rows[0] ?? null;
        },
        async collect() { return apply(); },
        async take(n: number) { return apply().slice(0, n); },
        // Position cursors, as offsets into the matched rows. Real enough to test
        // that a page respects its size, that `isDone` is honest, and that the
        // next cursor reaches the rows the first page did not.
        async paginate(opts: any) {
          const rows = apply();
          const numItems = opts?.numItems ?? rows.length;
          const start = opts?.cursor ? parseInt(String(opts.cursor), 10) || 0 : 0;
          const end = start + numItems;
          return {
            page: rows.slice(start, end),
            isDone: end >= rows.length,
            continueCursor: String(end),
          };
        },
        // The streaming read path (scopedFetch's stripFields `for await`).
        async *[Symbol.asyncIterator]() {
          for (const r of apply()) yield r;
        },
      };
      return builder;
    },
    async get(id: any) {
      for (const rows of Object.values(tables)) { const r = rows.find((x: any) => x._id === id); if (r) return r; }
      return null;
    },
    normalizeId(table: string, id: string) {
      return (tables[table] ?? []).some((row: any) => String(row._id) === String(id)) ? id : null;
    },
    async insert(table: string, doc: any) {
      // Skip ids the seed already uses: a seeded "chat_channels_1" and a minted
      // "chat_channels_1" would make db.get() answer with the wrong row.
      let n = inserted.length + 1;
      const taken = (id: string) =>
        Object.values(tables).some((rows) => rows.some((r: any) => r._id === id));
      let _id = `${table}_${n}`;
      while (taken(_id)) _id = `${table}_${++n}`;
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
    async replace(id: any, doc: any) {
      replaced.push({ _id: id, doc });
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((x: any) => x._id === id);
        if (i >= 0) {
          rows[i] = { _id: id, ...doc };
          return;
        }
      }
    },
    async delete(id: any) {
      deleted.push(id);
      for (const rows of Object.values(tables)) { const i = rows.findIndex((x: any) => x._id === id); if (i >= 0) rows.splice(i, 1); }
    },
  };
  return db;
}
