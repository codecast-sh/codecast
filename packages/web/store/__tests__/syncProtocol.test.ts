import { describe, expect, it } from "bun:test";
import { applySyncTable } from "../syncProtocol";

type Row = { _id: string; updated_at: number; status: "open" | "done" | "dropped" };

const r = (id: string, updated_at: number, status: Row["status"] = "open"): Row =>
  ({ _id: id, updated_at, status });

describe("applySyncTable — snapshot mode", () => {
  it("drops prev rows that are missing from incoming (server authoritative)", () => {
    const prev: Record<string, Row> = { a: r("a", 1), b: r("b", 2) };
    const incoming: Row[] = [r("a", 5)];
    const { table } = applySyncTable("tasks", incoming, {}, prev);
    expect(Object.keys(table).sort()).toEqual(["a"]);
    expect(table.a.updated_at).toBe(5);
  });
});

describe("applySyncTable — delta mode", () => {
  it("preserves prev rows that are absent from the delta", () => {
    const prev: Record<string, Row> = { a: r("a", 1), b: r("b", 2), c: r("c", 3) };
    const incoming: Row[] = [r("a", 10)];
    const { table } = applySyncTable("tasks", incoming, {}, prev, { isDelta: true });
    expect(Object.keys(table).sort()).toEqual(["a", "b", "c"]);
    expect(table.a.updated_at).toBe(10);
    expect(table.b.updated_at).toBe(2);
    expect(table.c.updated_at).toBe(3);
  });

  it("treats a soft-delete (status='dropped') as an update, not a removal", () => {
    const prev: Record<string, Row> = { a: r("a", 1), b: r("b", 2) };
    const incoming: Row[] = [r("a", 5, "dropped")];
    const { table } = applySyncTable("tasks", incoming, {}, prev, { isDelta: true });
    expect(Object.keys(table).sort()).toEqual(["a", "b"]);
    expect(table.a.status).toBe("dropped");
  });

  it("adds new rows from a delta", () => {
    const prev: Record<string, Row> = { a: r("a", 1) };
    const incoming: Row[] = [r("z", 9)];
    const { table } = applySyncTable("tasks", incoming, {}, prev, { isDelta: true });
    expect(Object.keys(table).sort()).toEqual(["a", "z"]);
  });

  it("respects field pending overrides for incoming rows", () => {
    const prev: Record<string, Row> = { a: r("a", 1) };
    const incoming: Row[] = [r("a", 5, "open")];
    const pending = { "tasks:a:status": { type: "field" as const, value: "done" } };
    const { table } = applySyncTable("tasks", incoming, pending, prev, { isDelta: true });
    expect(table.a.status).toBe("done");
  });

  it("does NOT clear pending excludes just because the delta omits a record", () => {
    const prev: Record<string, Row> = { a: r("a", 1) };
    const incoming: Row[] = [];
    const pending = { "tasks:a": { type: "exclude" as const } };
    const { pending: nextPending } = applySyncTable("tasks", incoming, pending, prev, { isDelta: true });
    expect(nextPending["tasks:a"]?.type).toBe("exclude");
  });
});

// Identity reuse keys on scalar-field equality, NOT updated_at alone. The inbox
// renders/buckets on fields (agent_status, is_idle, awaiting_input) that the
// server derives from managed_sessions + a wall-clock grace — they flip WITHOUT
// bumping conversations.updated_at. The old updated_at-only key dropped those
// changes, pinning a finished agent in "Working" until an unrelated edit bumped
// updated_at. This is automatic for every table — no per-table config.
describe("applySyncTable — scalar-equality version key (no config required)", () => {
  type Sess = {
    _id: string; updated_at: number; agent_status: string; is_idle: boolean;
    active_task?: { status: string };
  };

  it("applies a status change even when updated_at is unchanged", () => {
    const prev: Record<string, Sess> = {
      a: { _id: "a", updated_at: 100, agent_status: "working", is_idle: false },
    };
    const incoming: Sess[] = [{ _id: "a", updated_at: 100, agent_status: "idle", is_idle: true }];
    const { table } = applySyncTable("sessions", incoming, {}, prev);
    expect(table.a.agent_status).toBe("idle");
    expect(table.a.is_idle).toBe(true);
  });

  it("preserves object identity when every scalar is unchanged (heartbeat resend)", () => {
    const prevObj: Sess = { _id: "a", updated_at: 100, agent_status: "working", is_idle: false };
    const prev: Record<string, Sess> = { a: prevObj };
    // A heartbeat-only resend: identical scalars. Identity must hold so
    // React.memo doesn't re-render every SessionCard on every heartbeat.
    const incoming: Sess[] = [{ _id: "a", updated_at: 100, agent_status: "working", is_idle: false }];
    const { table } = applySyncTable("sessions", incoming, {}, prev);
    expect(table.a).toBe(prevObj);
  });

  it("uses a fresh object ref when any scalar changes (so React.memo re-renders)", () => {
    const prevObj: Sess = { _id: "a", updated_at: 100, agent_status: "working", is_idle: false };
    const prev: Record<string, Sess> = { a: prevObj };
    const incoming: Sess[] = [{ _id: "a", updated_at: 100, agent_status: "stopped", is_idle: true }];
    const { table } = applySyncTable("sessions", incoming, {}, prev);
    expect(table.a).not.toBe(prevObj);
  });

  it("ignores nested object identity (Convex resends fresh refs) — reuse holds", () => {
    // Same scalars, but the server sent a brand-new nested object ref. Comparing
    // it by reference would churn every push; we skip non-scalars, so identity
    // is preserved.
    const prevObj: Sess = { _id: "a", updated_at: 100, agent_status: "working", is_idle: false, active_task: { status: "open" } };
    const prev: Record<string, Sess> = { a: prevObj };
    const incoming: Sess[] = [{ _id: "a", updated_at: 100, agent_status: "working", is_idle: false, active_task: { status: "open" } }];
    const { table } = applySyncTable("sessions", incoming, {}, prev);
    expect(table.a).toBe(prevObj);
  });

  it("excludes ignoreFields from the version key (perf escape hatch)", () => {
    const prevObj: Sess = { _id: "a", updated_at: 100, agent_status: "working", is_idle: false };
    const prev: Record<string, Sess> = { a: prevObj };
    // tick changed but it's ignored, so identity is preserved.
    const incoming = [{ _id: "a", updated_at: 100, agent_status: "working", is_idle: false, tick: 999 }] as any;
    const { table } = applySyncTable("sessions", incoming, {}, prev, { ignoreFields: ["tick"] });
    expect(table.a).toBe(prevObj);
  });
});
