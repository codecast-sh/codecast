import { describe, expect, it } from "bun:test";
import { applySyncRecord, applySyncTable, applySyncPatch } from "./syncProtocol";
import type { PendingEntry } from "./types";

// The sync protocol is where local-first either holds or breaks: an optimistic
// write must survive every contradicting server push until the server itself
// echoes the same value, and a push that changes nothing must hand back the
// exact objects it was given (identity reuse) so no subscriber wakes.

type Row = { _id: string; title?: string; updated_at?: number; status?: string; live?: string | null };

const row = (id: string, extra: Partial<Row> = {}): Row => ({ _id: id, title: id, ...extra });

describe("pending protection", () => {
  it("keeps an optimistic field value over a contradicting server push", () => {
    const pending: Record<string, PendingEntry> = {
      "items:a:title": { type: "field", value: "local", ts: 1 },
    };

    const { table, pending: next } = applySyncTable(
      "items",
      [row("a", { title: "server" })],
      pending,
      { a: row("a", { title: "old" }) },
    );

    expect(table.a.title).toBe("local");
    // Still protected — the server has not echoed the local value yet.
    expect(next["items:a:title"]).toBeDefined();
  });

  it("clears the lock once the server echoes the local value", () => {
    const pending: Record<string, PendingEntry> = {
      "items:a:title": { type: "field", value: "local", ts: 1 },
    };
    const { table, pending: next } = applySyncTable(
      "items",
      [row("a", { title: "local" })],
      pending,
      { a: row("a", { title: "old" }) },
    );

    expect(table.a.title).toBe("local");
    expect(next["items:a:title"]).toBeUndefined();
  });

  it("treats an omitted field and a local null as the same acknowledgement for declared fields", () => {
    const pending: Record<string, PendingEntry> = {
      "items:a:hidden_at": { type: "field", value: null, ts: 1 },
      "items:a:other_at": { type: "field", value: null, ts: 1 },
    };
    const incoming = [{ _id: "a" }] as any[]; // server omits both fields
    const { pending: next } = applySyncTable("items", incoming, pending, { a: { _id: "a" } } as any, {
      optionalClearFields: new Set(["hidden_at"]),
    });

    expect(next["items:a:hidden_at"]).toBeUndefined();
    expect(next["items:a:other_at"]).toBeDefined();
  });

  it("retires an array-valued lock on a value-identical echo", () => {
    // The server re-sends collection-valued fields as fresh references on every
    // push, so a reference-only comparison would hold this lock forever and
    // freeze the field against every later server change.
    const pending: Record<string, PendingEntry> = {
      "items:a:label_ids": { type: "field", value: ["work", "urgent"], ts: 1 },
    };
    // prev holds the optimistic value already — the action wrote it there.
    const prev = { a: { _id: "a", label_ids: ["work", "urgent"], updated_at: 1 } };
    const incoming = [{ _id: "a", label_ids: ["work", "urgent"], updated_at: 2 }] as any[];

    const { table, pending: next } = applySyncTable("items", incoming, pending, prev as any);

    expect(table.a.label_ids).toEqual(["work", "urgent"]);
    expect(next["items:a:label_ids"]).toBeUndefined();
  });

  it("leaves a retired array lock's row to the identity-reuse rule", () => {
    // Identity reuse compares scalars only: an echo that changes an array
    // WITHOUT bumping updated_at looks like a no-op and hands back the previous
    // row. The lock still retires — the server agreed — and the next real edit
    // bumps updated_at and lands the value. Nested payloads have always ridden
    // updated_at this way; the value comparison did not change that.
    const pending: Record<string, PendingEntry> = {
      "items:a:label_ids": { type: "field", value: ["work"], ts: 1 },
    };
    const prev = { a: { _id: "a", label_ids: [], updated_at: 1 } };

    const { table, pending: next } = applySyncTable(
      "items",
      [{ _id: "a", label_ids: ["work"], updated_at: 1 }] as any[],
      pending,
      prev as any,
    );

    expect(table.a).toBe(prev.a);
    expect(next["items:a:label_ids"]).toBeUndefined();
  });

  it("keeps an array-valued lock while the server still disagrees", () => {
    const pending: Record<string, PendingEntry> = {
      "items:a:label_ids": { type: "field", value: ["work", "urgent"], ts: 1 },
    };
    const incoming = [{ _id: "a", label_ids: ["work"] }] as any[];

    const { table, pending: next } = applySyncTable("items", incoming, pending, {
      a: { _id: "a", label_ids: [] },
    } as any);

    expect(table.a.label_ids).toEqual(["work", "urgent"]);
    expect(next["items:a:label_ids"]).toBeDefined();
  });

  it("compares an object-valued lock by value too", () => {
    const pending: Record<string, PendingEntry> = {
      "items:a:flags": { type: "field", value: { starred: true }, ts: 1 },
    };
    const { pending: next } = applySyncTable(
      "items",
      [{ _id: "a", flags: { starred: true } }] as any[],
      pending,
      { a: { _id: "a", flags: {} } } as any,
    );
    expect(next["items:a:flags"]).toBeUndefined();
  });

  it("retires an array-valued lock through the single-record path", () => {
    const pending: Record<string, PendingEntry> = {
      "items:a:label_ids": { type: "field", value: ["work"], ts: 1 },
    };

    const held = applySyncRecord("items", "a", { _id: "a", label_ids: ["work", "later"] }, pending);
    expect(held.record.label_ids).toEqual(["work"]);
    expect(held.pending["items:a:label_ids"]).toBeDefined();

    const echoed = applySyncRecord("items", "a", { _id: "a", label_ids: ["work"] }, pending);
    expect(echoed.pending["items:a:label_ids"]).toBeUndefined();
  });

  it("returns the pending map untouched when nothing mutates it", () => {
    const pending: Record<string, PendingEntry> = { "items:a:title": { type: "field", value: "local" } };
    const { pending: next } = applySyncTable("items", [row("a", { title: "server" })], pending, {
      a: row("a"),
    });
    expect(next).toBe(pending);
  });
});

describe("exclude / include lifecycle", () => {
  it("blocks an excluded record and clears the tombstone once the server stops sending it", () => {
    const pending: Record<string, PendingEntry> = { "items:a": { type: "exclude", ts: 1 } };

    const blocked = applySyncTable("items", [row("a"), row("b")], pending, { a: row("a"), b: row("b") });
    expect(blocked.table.a).toBeUndefined();
    expect(blocked.table.b).toBeDefined();
    expect(blocked.pending["items:a"]).toBeDefined();

    const cleared = applySyncTable("items", [row("b")], pending, { b: row("b") });
    expect(cleared.pending["items:a"]).toBeUndefined();
  });

  it("keeps an included record until the server starts sending it", () => {
    const pending: Record<string, PendingEntry> = { "items:stub": { type: "include", ts: 1 } };
    const prev = { stub: row("stub") };

    const held = applySyncTable("items", [], pending, prev);
    expect(held.table.stub).toBe(prev.stub);
    expect(held.pending["items:stub"]).toBeDefined();

    const acknowledged = applySyncTable("items", [row("stub")], pending, prev);
    expect(acknowledged.pending["items:stub"]).toBeUndefined();
  });

  it("never clears a tombstone from a delta batch (absence is not deletion)", () => {
    const pending: Record<string, PendingEntry> = {
      "items:a": { type: "exclude", ts: 1 },
      "items:stub": { type: "include", ts: 1 },
    };
    const { pending: next } = applySyncTable("items", [row("b")], pending, { b: row("b") }, { isDelta: true });
    expect(next["items:a"]).toBeDefined();
    expect(next["items:stub"]).toBeDefined();
  });
});

describe("identity reuse and nested fields", () => {
  it("a change to a nested object alone is swallowed by identity reuse unless the field is deep", () => {
    const prev = { p: { _id: "p", name: "P", task_counts: { total: 1, done: 0 } } } as any;
    const incoming = [{ _id: "p", name: "P", task_counts: { total: 1, done: 1 } }] as any;
    const plain = applySyncTable("projects", incoming, {}, prev, { isDelta: true });
    expect(plain.table.p).toBe(prev.p); // the documented skip: object fields are not versioned
    const deep = applySyncTable("projects", incoming, {}, prev, { isDelta: true, deepFields: ["task_counts"] });
    expect(deep.table.p).toBe(incoming[0]);
    // Equal content keeps the identity even though the push minted a fresh object.
    const same = applySyncTable("projects", [{ _id: "p", name: "P", task_counts: { total: 1, done: 0 } }] as any, {}, prev, { isDelta: true, deepFields: ["task_counts"] });
    expect(same.table.p).toBe(prev.p);
  });
});

describe("delta vs snapshot semantics", () => {
  it("drops rows absent from a snapshot and keeps them in a delta", () => {
    const prev = { a: row("a"), b: row("b") };

    const snapshot = applySyncTable("items", [row("a", { updated_at: 2 })], {}, prev);
    expect(Object.keys(snapshot.table)).toEqual(["a"]);

    const delta = applySyncTable("items", [row("a", { updated_at: 2 })], {}, prev, { isDelta: true });
    expect(Object.keys(delta.table).sort()).toEqual(["a", "b"]);
    expect(delta.table.b).toBe(prev.b);
  });

  it("appends rows new in incoming after the previous ordering", () => {
    const prev = { a: row("a"), b: row("b") };
    const delta = applySyncTable("items", [row("b"), row("c")], {}, prev, { isDelta: true });
    expect(Object.keys(delta.table)).toEqual(["a", "b", "c"]);
    // A snapshot keeps prev's ordering for the rows it still carries, then
    // appends the newcomers; rows the server omitted are gone.
    const snapshot = applySyncTable("items", [row("c"), row("b")], {}, prev);
    expect(Object.keys(snapshot.table)).toEqual(["b", "c"]);
  });
});

describe("pruneAbsentScope", () => {
  const prev = {
    a: row("a", { status: "in" }),
    b: row("b", { status: "in" }),
    c: row("c", { status: "out" }),
  };
  const inScope = (r: Row) => r.status === "in";

  it("removes an in-scope row absent from a complete payload, via an exclude", () => {
    const { table, pending } = applySyncTable("items", [row("a", { status: "in" })], {}, prev, {
      isDelta: true,
      pruneAbsentScope: inScope,
    });
    expect(table.b).toBeUndefined();
    expect(pending["items:b"]).toEqual({ type: "exclude", ts: expect.any(Number) } as any);
    // Out-of-scope rows keep the normal delta behavior.
    expect(table.c).toBe(prev.c);
  });

  it("never prunes a row with local pending state", () => {
    const pending: Record<string, PendingEntry> = { "items:b:title": { type: "field", value: "mine" } };
    const { table } = applySyncTable("items", [row("a", { status: "in" })], pending, prev, {
      isDelta: true,
      pruneAbsentScope: inScope,
    });
    expect(table.b).toBe(prev.b);
  });
});

describe("identity reuse", () => {
  it("reuses the previous row object when no scalar changed", () => {
    const prev = { a: row("a", { updated_at: 1 }) };
    const { table } = applySyncTable("items", [row("a", { updated_at: 1 })], {}, prev, { isDelta: true });
    expect(table.a).toBe(prev.a);
  });

  it("reuses the whole collection object when no row changed", () => {
    const prev = { a: row("a", { updated_at: 1 }), b: row("b", { updated_at: 1 }) };
    const { table } = applySyncTable(
      "items",
      [row("a", { updated_at: 1 }), row("b", { updated_at: 1 })],
      {},
      prev,
    );
    expect(table).toBe(prev);
  });

  it("takes the incoming row when any scalar differs, even without updated_at", () => {
    const prev = { a: row("a", { updated_at: 1, status: "idle" }) };
    const { table } = applySyncTable("items", [row("a", { updated_at: 1, status: "busy" })], {}, prev);
    expect(table.a).not.toBe(prev.a);
    expect(table.a.status).toBe("busy");
  });

  it("takes the incoming row when a field crosses between null and an object", () => {
    const prev: Record<string, any> = { user: { _id: "user", scope_type: "user", anchor: null } };
    const { table } = applySyncTable<any>(
      "anchorSpaces",
      [{ _id: "user", scope_type: "user", anchor: { _id: "x1", name: "Anchor" } }],
      {},
      prev,
      { isDelta: true },
    );
    expect(table.user).not.toBe(prev.user);
    expect(table.user.anchor?.name).toBe("Anchor");
  });

  it("ignores fields listed as churn for the version key", () => {
    const prev = { a: row("a", { updated_at: 1 }) };
    const { table } = applySyncTable("items", [row("a", { updated_at: 99 })], {}, prev, {
      ignoreFields: ["updated_at"],
    });
    expect(table.a).toBe(prev.a);
  });
});

describe("preserveFields", () => {
  it("fills an overlay-owned field from prev when the base payload carries null", () => {
    const prev: Record<string, Row> = { a: { _id: "a", title: "a", live: "on" } };
    const { table } = applySyncTable<Row>("items", [{ _id: "a", title: "a", live: null }], {}, prev, {
      preserveFields: ["live"],
    });
    // Identity is reused because only the overlay field would have differed.
    expect(table.a).toBe(prev.a);
    expect(table.a.live).toBe("on");
  });

  it("lets a real incoming value win over the preserved one", () => {
    const prev = { a: { _id: "a", title: "a", live: "on" } };
    const { table } = applySyncTable("items", [{ _id: "a", title: "a", live: "off" }], {}, prev, {
      preserveFields: ["live"],
    });
    expect(table.a.live).toBe("off");
  });
});

describe("applySyncRecord", () => {
  it("overrides a field until the server echoes, then clears the lock", () => {
    const pending: Record<string, PendingEntry> = { "items:a:title": { type: "field", value: "local" } };

    const held = applySyncRecord("items", "a", { _id: "a", title: "server" }, pending);
    expect(held.record.title).toBe("local");
    expect(held.pending["items:a:title"]).toBeDefined();

    const echoed = applySyncRecord("items", "a", { _id: "a", title: "local" }, pending);
    expect(echoed.pending["items:a:title"]).toBeUndefined();
  });

  it("passes an excluded record straight through for the caller to drop", () => {
    const pending: Record<string, PendingEntry> = { "items:a": { type: "exclude" } };
    const { record } = applySyncRecord("items", "a", { _id: "a", title: "server" }, pending);
    expect(record.title).toBe("server");
  });
});

// ── applySyncPatch: partial-patch pending protection (sync-log cargo) ─────────
// The rule this pins: a PARTIAL patch visits ONLY the locks for fields it names
// (patch or unset). applySyncRecord treats a missing key as the server's value,
// so a lock recorded for a local CLEAR (value undefined) would echo against the
// omitted key and retire before the clear ever landed.
describe("applySyncPatch", () => {
  const T = "tasks";
  it("a lock on a field the patch omits survives untouched", () => {
    const pending = { [`${T}:t1:assignee`]: { type: "field" as const, value: undefined, ts: 1 } };
    const r = applySyncPatch(T, "t1", { title: "new" }, [], pending);
    expect(r.pending[`${T}:t1:assignee`]).toBeDefined();
    expect(r.fields).toEqual({ title: "new" });
  });
  it("a named field's lock wins until its value echoes", () => {
    const pending = { [`${T}:t1:status`]: { type: "field" as const, value: "done", ts: 1 } };
    let r = applySyncPatch(T, "t1", { status: "open" }, [], pending);
    expect(r.fields.status).toBe("done");
    expect(r.pending[`${T}:t1:status`]).toBeDefined();
    r = applySyncPatch(T, "t1", { status: "done" }, [], pending);
    expect(r.pending[`${T}:t1:status`]).toBeUndefined();
  });
  it("unset echoes an undefined-valued lock and retires it; a locked value blocks the unset", () => {
    const pending = {
      [`${T}:t1:assignee`]: { type: "field" as const, value: undefined, ts: 1 },
      [`${T}:t1:label`]: { type: "field" as const, value: "keep", ts: 1 },
    };
    const r = applySyncPatch(T, "t1", {}, ["assignee", "label"], pending);
    expect(r.pending[`${T}:t1:assignee`]).toBeUndefined();
    expect(r.unset).toEqual(["assignee"]);
    expect(r.pending[`${T}:t1:label`]).toBeDefined();
  });
  it("unset of an optional-clear field echoes a null-valued lock", () => {
    const pending = { [`${T}:t1:inbox_pinned_at`]: { type: "field" as const, value: null, ts: 1 } };
    const r = applySyncPatch(T, "t1", {}, ["inbox_pinned_at"], pending, new Set(["inbox_pinned_at"]));
    expect(r.pending[`${T}:t1:inbox_pinned_at`]).toBeUndefined();
    expect(r.unset).toEqual(["inbox_pinned_at"]);
  });
  it("an exclude on the row passes the patch through untouched", () => {
    const pending = { [`${T}:t1`]: { type: "exclude" as const, ts: 1 } };
    const r = applySyncPatch(T, "t1", { title: "x" }, ["y"], pending);
    expect(r.fields).toEqual({ title: "x" });
    expect(r.unset).toEqual(["y"]);
  });
});
