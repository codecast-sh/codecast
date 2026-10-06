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
// given. With FakeDbOptions.indexes (the multiplayer sim's db), every read
// follows the schema's real index instead: its order, its field rules and its
// key cursors.
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
    case "lt": return a[0] === undefined ? a[1] !== undefined : a[1] !== undefined && a[0] < a[1];
    case "lte": return a[0] === undefined || (a[1] !== undefined && a[0] <= a[1]);
    case "gt": return a[1] === undefined ? a[0] !== undefined : a[0] !== undefined && a[0] > a[1];
    case "gte": return a[1] === undefined || (a[0] !== undefined && a[0] >= a[1]);
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

// An index field may name a nested path ("external.ts"), as convex allows.
function fieldValue(row: any, field: string): any {
  if (!field.includes(".")) return row[field];
  return field.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), row);
}

// Opt-in fidelity for the multiplayer sim (convex/simBackend.testing.ts).
// Every option is off by default, and with none set the db behaves exactly as
// it always has, so existing tests see no change.
export interface FakeDbOptions {
  // Mint the id of an inserted row; `n` counts inserts into that table from 1.
  // Minted ids are never reused, even after a rollback, as in convex. When
  // set, rows are also indexed by id, so get/patch/replace/delete skip the
  // table scan (rows must then enter and leave through the db or the seed).
  mintId?: (table: string, n: number) => string;
  // Stamp `_creationTime` on an insert that lacks one. Strictly increasing,
  // even when the clock stands still (a virtual clock usually does).
  creationTime?: () => number;
  // A patch value of `undefined` removes the field, as convex does. Without
  // it the key stays on the row holding `undefined`.
  strictPatch?: boolean;
  // The schema's indexes, table -> index name -> fields (schemaIndexes()).
  // When set, reads follow the named index as convex does: an unknown index,
  // or an eq or range out of the index's field order, throws; every read
  // returns rows in index key order (the fields, then _creationTime, then
  // _id), ascending unless order("desc"); a query with no index reads
  // by_creation_time; and paginate cursors carry the last row's key, so a row
  // written between pages neither repeats nor skips one.
  indexes?: Record<string, Record<string, string[]>>;
}

/** Every table's index fields, from a defineSchema() result. */
export function schemaIndexes(schema: { tables: Record<string, any> }): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  for (const [table, def] of Object.entries(schema.tables)) {
    out[table] = {};
    for (const index of def[" indexes"]() as Array<{ indexDescriptor: string; fields: string[] }>) {
      out[table][index.indexDescriptor] = index.fields;
    }
  }
  return out;
}

// Convex's total order over values: undefined < null < bigint < number <
// boolean < string < bytes < array < object.
function typeRank(v: any): number {
  if (v === undefined) return 0;
  if (v === null) return 1;
  if (typeof v === "bigint") return 2;
  if (typeof v === "number") return 3;
  if (typeof v === "boolean") return 4;
  if (typeof v === "string") return 5;
  if (v instanceof ArrayBuffer) return 6;
  if (Array.isArray(v)) return 7;
  return 8;
}

export function compareConvexValues(a: any, b: any): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 7) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareConvexValues(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length - b.length;
  }
  if (ra === 6 || ra === 8) {
    const ja = JSON.stringify(ra === 6 ? [...new Uint8Array(a)] : a);
    const jb = JSON.stringify(rb === 6 ? [...new Uint8Array(b)] : b);
    return ja < jb ? -1 : ja > jb ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// The built-in indexes every table has.
const SYSTEM_INDEXES: Record<string, string[]> = { by_creation_time: ["_creationTime"], by_id: ["_id"] };

// A key tuple survives JSON with undefined kept apart from null.
const UNDEFINED_KEY = { $undefined: true };
const encodeKey = (key: any[]) => "key:" + JSON.stringify(key.map((v) => (v === undefined ? UNDEFINED_KEY : v)));
const decodeKey = (cursor: string): any[] =>
  (JSON.parse(cursor.slice(4)) as any[]).map((v) => (v && typeof v === "object" && v.$undefined === true ? undefined : v));

type JournalEntry =
  | { kind: "insert"; table: string; id: string }
  | { kind: "patch"; row: any; before: any }
  | { kind: "replace"; table: string; index: number; before: any }
  | { kind: "delete"; table: string; index: number; row: any };

export function makeFakeDb(tables: Record<string, any[]>, opts: FakeDbOptions = {}) {
  const idTables = new Map<string, string>();
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) idTables.set(String(row._id), table);
  }
  const inserted: Array<{ table: string; doc: any; _id: string }> = [];
  const patched: Array<{ _id: any; patch: any }> = [];
  const replaced: Array<{ _id: any; doc: any }> = [];
  const deleted: any[] = [];
  // Id index, kept only when ids are minted (see FakeDbOptions.mintId).
  const byId = opts.mintId ? new Map<string, any>() : null;
  if (byId) for (const rows of Object.values(tables)) for (const row of rows) byId.set(String(row._id), row);
  const mintCounts = new Map<string, number>();
  let lastCreationTime = -Infinity;
  let writeCount = 0;
  // Undo log of the open journal, null when none is open.
  let journal: JournalEntry[] | null = null;
  let journalStart = { writes: 0, inserted: 0, patched: 0, replaced: 0, deleted: 0, tables: new Set<string>() };
  // The table row with this id: a map hit when ids are indexed, else a scan.
  const rowFor = (id: any): any | null => {
    const hit = byId?.get(String(id));
    if (hit) return hit;
    for (const rows of Object.values(tables)) {
      const r = rows.find((x: any) => x._id === id);
      if (r) return r;
    }
    return null;
  };
  // The row with its table and position, for writes that move it.
  const locate = (id: any): { table: string; rows: any[]; index: number } | null => {
    const row = rowFor(id);
    if (!row) return null;
    const known = idTables.get(String(id));
    const table = known && tables[known]?.includes(row)
      ? known
      : Object.keys(tables).find((name) => tables[name]!.includes(row));
    if (!table) return null;
    const rows = tables[table]!;
    const index = rows.indexOf(row);
    return index >= 0 ? { table, rows, index } : null;
  };
  const db: any = {
    _tables: tables,
    _inserted: inserted,
    _patched: patched,
    _replaced: replaced,
    _deleted: deleted,
    // Inserts, patches, replaces and deletes so far. A rollback restores it.
    get __writeCount() { return writeCount; },
    // Start recording undo entries for every write, until commit or rollback.
    __beginJournal() {
      if (journal) throw new Error("fake db: a journal is already open");
      journal = [];
      journalStart = {
        writes: writeCount,
        inserted: inserted.length,
        patched: patched.length,
        replaced: replaced.length,
        deleted: deleted.length,
        tables: new Set(Object.keys(tables)),
      };
    },
    __commit() { journal = null; },
    // Undo every write since __beginJournal, newest first, and close it.
    __rollback() {
      const entries = journal ?? [];
      journal = null;
      for (const entry of entries.reverse()) {
        if (entry.kind === "insert") {
          const rows = tables[entry.table] ?? [];
          const index = rows.findIndex((x: any) => x._id === entry.id);
          if (index >= 0) rows.splice(index, 1);
          byId?.delete(entry.id);
          idTables.delete(entry.id);
        } else if (entry.kind === "patch") {
          for (const key of Object.keys(entry.row)) delete entry.row[key];
          Object.assign(entry.row, entry.before);
        } else if (entry.kind === "replace") {
          tables[entry.table]![entry.index] = entry.before;
          byId?.set(String(entry.before._id), entry.before);
        } else {
          (tables[entry.table] ??= []).splice(entry.index, 0, entry.row);
          byId?.set(String(entry.row._id), entry.row);
        }
      }
      // A table the journal's first insert created goes too.
      for (const name of Object.keys(tables)) {
        if (!journalStart.tables.has(name) && tables[name]!.length === 0) delete tables[name];
      }
      writeCount = journalStart.writes;
      inserted.length = journalStart.inserted;
      patched.length = journalStart.patched;
      replaced.length = journalStart.replaced;
      deleted.length = journalStart.deleted;
    },
    query(table: string) {
      const filters: Array<[string, any]> = [];
      // A search index is an eq-filter chain plus one substring term — enough to
      // test the scoping and shaping around a text search, not the ranking.
      let search: [string, string] | null = null;
      // Unset until the caller asks. An unordered query keeps insertion order,
      // which is what every test written before ordering existed assumes.
      let direction: "asc" | "desc" | null = null;
      const predicates: FilterExpr[] = [];
      // A range bound on an index field names that index's sort key (a real
      // index orders by the field its range constrains — the dismissed and
      // stashed windows order by their stamp, not by updated_at). With no
      // range, every time-ordered index in this schema is keyed on one of
      // these, so ordering by it is what `order()` means here. Rows without
      // one keep insertion order (the sort is stable). `last_activity_at`
      // comes first: the tables that have it (thread_reads) index on it, and
      // their `updated_at` moves on every mark-read — ordering by that would
      // shuffle the Threads inbox whenever a row was touched. `at` comes last:
      // it is the whole clock of a row that carries no other stamp
      // (initiative_updates), so it can reorder nothing that sorted before.
      let rangeKey: string | null = null;
      // The named index's fields, when the db reads the schema's indexes. A
      // query that names none reads by_creation_time, as convex does.
      let indexFields: string[] | null = opts.indexes ? SYSTEM_INDEXES.by_creation_time! : null;
      const indexKey = (row: any) => [...indexFields!.map((f) => fieldValue(row, f)), row._creationTime, row._id];
      const compareKeys = (a: any[], b: any[]) => {
        for (let i = 0; i < a.length; i++) {
          const c = compareConvexValues(a[i], b[i]);
          if (c !== 0) return c;
        }
        return 0;
      };
      const timeKey = (row: any) =>
        rangeKey ? (row[rangeKey] ?? null)
          : row.last_activity_at ?? row.created_at ?? row.timestamp ?? row.updated_at ?? row.at ?? null;
      const apply = () => {
        const rows = (tables[table] ?? [])
          .filter((r) => filters.every(([f, v]) => fieldValue(r, f) === v))
          .filter((r) => predicates.every((p) => !!evalFilter(p, r)))
          .filter((r) => !search
            || String(r[search[0]] ?? "").toLowerCase().includes(search[1].toLowerCase()));
        if (indexFields && !search) {
          const sign = direction === "desc" ? -1 : 1;
          return rows
            .map((row) => [row, indexKey(row)] as const)
            .sort(([, a], [, b]) => compareKeys(a, b) * sign)
            .map(([row]) => row);
        }
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
      // A row handed to a handler is a SNAPSHOT, as in convex: a later patch
      // changes the table row, never the object the handler already holds.
      // Aliasing let updateAgentStatus read its own status write through the
      // row it compared against, so an active status never settled in tests.
      // Table rows themselves stay stable objects (patch mutates in place), so
      // a test may keep a reference to db._tables.x[i] and watch it change.
      const snapshot = () => apply().map((r: any) => ({ ...r }));
      const builder: any = {
        withIndex(name: string, fn?: (q: any) => any) {
          // With the schema's indexes, the name decides the order and the
          // fields an eq or a range may name, in order: eqs on a prefix, then
          // bounds on the next field.
          let fields: string[] | null = null;
          if (opts.indexes) {
            fields = SYSTEM_INDEXES[name] ?? opts.indexes[table]?.[name] ?? null;
            if (!fields) throw new Error(`fake db: table ${table} has no index ${name}`);
            indexFields = fields;
          }
          let eqs = 0;
          let rangeField: string | null = null;
          const checkEq = (field: string) => {
            if (!fields) return;
            if (rangeField || fields[eqs] !== field) {
              throw new Error(`fake db: ${table}.${name} cannot take eq("${field}") here; its fields are ${fields.join(", ")}`);
            }
            eqs++;
          };
          const checkRange = (field: string) => {
            if (!fields) return;
            if (rangeField ? rangeField !== field : fields[eqs] !== field) {
              throw new Error(`fake db: ${table}.${name} cannot take a range on "${field}" here; its fields are ${fields.join(", ")}`);
            }
            rangeField = field;
          };
          if (fn) {
            // Range bounds are REAL. "Everything since your read mark" and
            // "everything before this page" are the whole meaning of the queries
            // that use them, and a no-op bound answers a different question —
            // one where the unread count is the channel's entire history.
            const range = (kind: string) => (f: string, v: any) => {
              checkRange(f);
              rangeKey = f;
              predicates.push(op(kind, filterBuilder.field(f), v));
              return q;
            };
            const q: any = {
              eq(field: string, val: any) { checkEq(field); filters.push([field, val]); return q; },
              gte: range("gte"),
              gt: range("gt"),
              lte: range("lte"),
              lt: range("lt"),
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
        async first() { return snapshot()[0] ?? null; },
        async unique() {
          const rows = snapshot();
          if (rows.length > 1) throw new Error("Query returned more than one result");
          return rows[0] ?? null;
        },
        async collect() { return snapshot(); },
        async take(n: number) { return snapshot().slice(0, n); },
        // Position cursors, as offsets into the matched rows. Real enough to test
        // that a page respects its size, that `isDone` is honest, and that the
        // next cursor reaches the rows the first page did not. With the
        // schema's indexes the cursor is the last row's index key instead, as
        // in convex, so a write between pages cannot shift the window.
        async paginate(opts: any) {
          const rows = snapshot();
          if (indexFields && !search) {
            const sign = direction === "desc" ? -1 : 1;
            const cursor = String(opts?.cursor ?? "");
            const after = cursor.startsWith("key:") ? decodeKey(cursor) : null;
            const rest = after ? rows.filter((row) => compareKeys(indexKey(row), after) * sign > 0) : rows;
            const page = rest.slice(0, opts?.numItems ?? rest.length);
            const last = page.at(-1);
            return {
              page,
              isDone: page.length >= rest.length,
              // An empty page keeps the cursor it was given, so the next call
              // still starts where this one did.
              continueCursor: last ? encodeKey(indexKey(last)) : cursor,
            };
          }
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
          for (const r of snapshot()) yield r;
        },
      };
      return builder;
    },
    async get(id: any) {
      if (byId) {
        const r = rowFor(id);
        return r ? { ...r } : null;
      }
      for (const rows of Object.values(tables)) { const r = rows.find((x: any) => x._id === id); if (r) return { ...r }; }
      return null;
    },
    normalizeId(table: string, id: string) {
      if (!idTables.has(id)) {
        for (const [name, rows] of Object.entries(tables)) {
          if (rows.some((row) => String(row._id) === id)) {
            idTables.set(id, name);
            break;
          }
        }
      }
      return idTables.get(id) === table ? id : null;
    },
    async insert(table: string, doc: any) {
      writeCount++;
      let _id: string;
      if (opts.mintId) {
        const n = (mintCounts.get(table) ?? 0) + 1;
        mintCounts.set(table, n);
        _id = opts.mintId(table, n);
      } else {
        // Skip ids the seed already uses: a seeded "chat_channels_1" and a minted
        // "chat_channels_1" would make db.get() answer with the wrong row.
        let n = inserted.length + 1;
        const taken = (id: string) =>
          Object.values(tables).some((rows) => rows.some((r: any) => r._id === id));
        _id = `${table}_${n}`;
        while (taken(_id)) _id = `${table}_${++n}`;
      }
      idTables.set(_id, table);
      let row: any = { _id, ...doc };
      if (opts.creationTime && doc?._creationTime === undefined) {
        lastCreationTime = Math.max(opts.creationTime(), lastCreationTime + 0.001);
        row = { _id, _creationTime: lastCreationTime, ...doc };
      }
      (tables[table] ??= []).push(row);
      byId?.set(_id, row);
      inserted.push({ table, doc, _id });
      journal?.push({ kind: "insert", table, id: _id });
      return _id;
    },
    async patch(id: any, patch: any) {
      writeCount++;
      patched.push({ _id: id, patch });
      if (byId || journal || opts.strictPatch) {
        const r = rowFor(id);
        if (!r) return;
        journal?.push({ kind: "patch", row: r, before: { ...r } });
        Object.assign(r, patch);
        if (opts.strictPatch) {
          for (const [key, value] of Object.entries(patch ?? {})) if (value === undefined) delete r[key];
        }
        return;
      }
      for (const rows of Object.values(tables)) {
        const r = rows.find((x: any) => x._id === id);
        if (r) { Object.assign(r, patch); return; }
      }
    },
    async replace(id: any, doc: any) {
      writeCount++;
      replaced.push({ _id: id, doc });
      if (byId || journal) {
        const found = locate(id);
        if (!found) return;
        const before = found.rows[found.index];
        journal?.push({ kind: "replace", table: found.table, index: found.index, before });
        // A replace keeps the system fields, as convex does.
        const next = before._creationTime === undefined
          ? { _id: id, ...doc }
          : { _id: id, _creationTime: before._creationTime, ...doc };
        found.rows[found.index] = next;
        byId?.set(String(id), next);
        return;
      }
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((x: any) => x._id === id);
        if (i >= 0) {
          rows[i] = { _id: id, ...doc };
          return;
        }
      }
    },
    async delete(id: any) {
      writeCount++;
      deleted.push(id);
      if (byId || journal) {
        const found = locate(id);
        if (!found) return;
        const [row] = found.rows.splice(found.index, 1);
        byId?.delete(String(id));
        journal?.push({ kind: "delete", table: found.table, index: found.index, row });
        return;
      }
      for (const rows of Object.values(tables)) { const i = rows.findIndex((x: any) => x._id === id); if (i >= 0) rows.splice(i, 1); }
    },
  };
  return db;
}

/**
 * Standing triggers armed on each event name, one row per name. A producer
 * schedules a trigger match only when one is armed (lib/triggerMatch), so a
 * test asserting that an event fires seeds these. Append them after any row a
 * test reads by position.
 */
export function armedTriggerRows(...eventTypes: string[]): any[] {
  return eventTypes.map((event_type) => ({
    _id: `armed_${event_type}`,
    user_id: "user_armed",
    title: `Armed on ${event_type}`,
    prompt: "",
    status: "scheduled",
    schedule_type: "event",
    event_filter: { event_type },
    retry_count: 0,
    run_count: 0,
    created_at: 0,
  }));
}
