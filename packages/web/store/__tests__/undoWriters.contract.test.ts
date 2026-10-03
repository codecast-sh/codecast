import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, performRedo, performUndo } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { NO_CLEAR, UNDO_WIRE_TABLES, UNDO_WRITERS } from "../undo/writers";
import { closeTaskWithGuard, resolveTaskCloseGuard, setTaskParent } from "../../lib/taskActions";

// The writer contract, generated over UNDO_WRITERS and their wire tables. For
// every field a writer carries, in both directions that can happen (a prior
// value, and no prior value):
//
//   forward → a stale push still carrying the old row → undo → a stale push
//   carrying the forward value → the server's echo of the undo
//
// After the undo the row holds the prior value (or, for a field the server
// stores rather than unsets, the server's spelling of the clear) at every
// step, no lock or exclude is left on the row once the echo lands, and the
// dispatch carries the writer's action with its wire args. A field whose
// server mutation cannot unset it records no undo at all when it had no
// prior value. `updated_at` is exempt from the lock check: every forward
// edit already locks a local stamp the server's own clock never echoes, and
// the undo restamps it the same way.

const ABSENT = Symbol("absent");
type Prior = unknown | typeof ABSENT;

const T = "t".repeat(32);
const T_PARENT = "p".repeat(32);
const T_OTHER = "o".repeat(32);
const PLAN = "l".repeat(32);
const PROJECT = "j".repeat(32);
const INITIATIVE = "i".repeat(32);
const DOC = "d".repeat(32);
const CONV = "c".repeat(32);
const ASSIGNMENT = "a".repeat(32);

type Fixture = {
  id: string;
  /** The row before the gesture, without the field under test. */
  seed: () => Record<string, any>;
  /** Extra rows the store needs (a task's parent). */
  others?: () => Record<string, Record<string, any>>;
  /** [prior, forward] per wire field. */
  samples: Record<string, [unknown, unknown]>;
  forward: (field: string, value: unknown) => void;
  /** The invocation the undo should dispatch, given the restored value (undefined = unset). */
  expected: (field: string, restored: unknown) => [string, unknown[]];
  syncOpts?: Record<string, unknown>;
  /** Wire fields the spec never captures, with why. */
  uncaptured?: Record<string, string>;
};

const s = () => useInboxStore.getState() as any;

const FIXTURES: Record<string, Fixture> = {
  tasks: {
    id: T,
    seed: () => ({ _id: T, short_id: "ct-1", title: "Fix it", status: "todo", priority: "medium", updated_at: 1 }),
    others: () => ({
      [T_PARENT]: { _id: T_PARENT, short_id: "ct-2", title: "Parent", status: "todo", priority: "medium", updated_at: 1 },
      [T_OTHER]: { _id: T_OTHER, short_id: "ct-3", title: "Other", status: "todo", priority: "medium", updated_at: 1 },
    }),
    samples: {
      status: ["todo", "in_progress"],
      status_id: ["st_a", "st_b"],
      priority: ["medium", "high"],
      title: ["Fix it", "Fix it now"],
      description: ["old", "new"],
      labels: [["a"], ["b"]],
      assignee: ["sam", "kim"],
      triage_status: ["inbox", "active"],
      execution_status: ["blocked", "running"],
      project_id: ["proj_a", "proj_b"],
      project_path: ["/a", "/b"],
      parent_id: [T_PARENT, T_OTHER],
      sort_order: [1, 2],
      duplicate_of: ["ct-8", "ct-9"],
    },
    forward: (field, value) => {
      if (field === "parent_id") {
        s().updateTask("ct-1", { parent: value === T_PARENT ? "ct-2" : "ct-3" });
      } else {
        s().updateTask("ct-1", { [field]: value });
      }
    },
    expected: (field, restored) => {
      if (field === "parent_id") return ["updateTask", ["ct-1", { parent: restored === T_PARENT ? "ct-2" : restored === T_OTHER ? "ct-3" : "" }]];
      return ["updateTask", ["ct-1", { [field]: restored ?? "" }]];
    },
    syncOpts: { isDelta: true },
    uncaptured: { description: "the editor owns its text undo" },
  },
  plans: {
    id: PLAN,
    seed: () => ({ _id: PLAN, short_id: "pl-1", title: "Plan", status: "active", updated_at: 1 }),
    samples: {
      title: ["Plan", "Plan B"],
      goal: ["ship", "ship faster"],
      acceptance_criteria: [["a"], ["b"]],
      status: ["active", "done"],
      task_ids: [["x"], ["y"]],
      context_pointers: [[{ label: "a", path_or_url: "/a" }], [{ label: "b", path_or_url: "/b" }]],
      project_id: ["proj_a", "proj_b"],
      success_metrics: [["m1"], ["m2"]],
      priority: ["p1", "p2"],
      owner_role_id: ["role_a", "role_b"],
      non_goals: [["n1"], ["n2"]],
    },
    forward: (field, value) => s().updatePlan("pl-1", { [field]: value }),
    expected: (field, restored) => ["updatePlan", ["pl-1", { [field]: restored === undefined ? clearWire("plans", field) : restored }]],
  },
  projects: {
    id: PROJECT,
    seed: () => ({ _id: PROJECT, title: "Project", status: "active", updated_at: 1 }),
    samples: {
      title: ["Project", "Project 2"],
      description: ["d1", "d2"],
      status: ["active", "paused"],
      color: ["red", "blue"],
      icon: ["a", "b"],
      target_date: [100, 200],
      labels: [["a"], ["b"]],
      horizon: ["ongoing", "bounded"],
      project_path: ["/a", "/b"],
      goal: ["g1", "g2"],
      success_metrics: [["m1"], ["m2"]],
      priority: ["p1", "p2"],
      owner_role_id: ["role_a", "role_b"],
      non_goals: [["n1"], ["n2"]],
      risks: [["r1"], ["r2"]],
      budget: [{ tokens_per_day: 1 }, { tokens_per_day: 2 }],
    },
    forward: (field, value) => s().updateProject(PROJECT, { [field]: value }),
    expected: (field, restored) => ["updateProject", [PROJECT, { [field]: restored === undefined ? clearWire("projects", field) : restored }]],
  },
  initiatives: {
    id: INITIATIVE,
    seed: () => ({ _id: INITIATIVE, short_id: "in-1", title: "Grow", status: "active", project_ids: [], health: "none", workspace: "user:u", user_id: "u", created_at: 1, updated_at: 1 }),
    samples: {
      title: ["Grow", "Grow more"],
      description: ["d1", "d2"],
      status: ["active", "done"],
      owner: [{ kind: "user", user_id: "u1" }, { kind: "user", user_id: "u2" }],
      target_date: [100, 200],
      priority: ["p1", "p2"],
      labels: [["a"], ["b"]],
      parent_initiative_id: ["in_a", "in_b"],
      metrics: [[{ key: "k", name: "n", target: "1" }], [{ key: "k", name: "n", target: "2" }]],
    },
    forward: (field, value) => s().updateInitiative(INITIATIVE, { [field]: value }),
    expected: (field, restored) => ["updateInitiative", [INITIATIVE, { [field]: restored === undefined ? clearWire("initiatives", field) : restored }]],
  },
  docs: {
    id: DOC,
    seed: () => ({ _id: DOC, title: "Notes", updated_at: 1 }),
    samples: {
      title: ["Notes", "Better notes"],
      doc_type: ["note", "spec"],
      labels: [["a"], ["b"]],
      pinned: [true, false],
      parent_id: ["doc_a", "doc_b"],
      sort_order: [1, 2],
    },
    forward: (field, value) => {
      const row = s().docs[DOC];
      if (field === "pinned") s().pinDoc(DOC, value);
      else if (field === "parent_id") s().moveDoc(DOC, value, row.sort_order);
      else if (field === "sort_order") s().moveDoc(DOC, row.parent_id, value);
      else s().updateDoc(DOC, { [field]: value });
    },
    expected: (field, restored) => {
      const row = s().docs[DOC];
      if (field === "pinned") return ["pinDoc", [DOC, restored === true]];
      // An unset parent or rank travels as null; webMoveDoc unsets the parent.
      if (field === "parent_id") return ["moveDoc", [DOC, restored ?? null, row.sort_order ?? null]];
      if (field === "sort_order") return ["moveDoc", [DOC, row.parent_id ?? null, restored ?? null]];
      return ["updateDoc", [DOC, { [field]: restored === undefined ? clearWire("docs", field) : restored }]];
    },
    syncOpts: { isDelta: true },
  },
  bucketAssignments: {
    id: ASSIGNMENT,
    seed: () => ({ _id: ASSIGNMENT, conversation_id: CONV, updated_at: 1 }),
    samples: { bucket_id: ["bkt_a", "bkt_b"] },
    forward: (_field, value) => s().assignSessionToBucket(CONV, value),
    expected: (_field, restored) => ["assignSessionToBucket", [CONV, restored ?? null]],
  },
};

function clearWire(store: string, field: string): unknown {
  return UNDO_WIRE_TABLES[store]![field];
}

/** What the row holds once the undo lands (and what the server echoes): the prior, or the server's clear. */
function restoredValue(store: string, field: string, prior: Prior): unknown {
  if (prior !== ABSENT) return prior;
  const clears = UNDO_WRITERS[store]?.clears ?? {};
  return field in clears ? clears[field] : undefined;
}

function seedRow(store: string, field: string, prior: Prior) {
  const f = FIXTURES[store]!;
  const row = { ...f.seed() };
  if (prior !== ABSENT) row[field] = prior;
  else delete row[field];
  useInboxStore.setState({ [store]: { ...(f.others?.() ?? {}), [f.id]: row }, pending: {} } as any);
  return row;
}

function push(store: string, row: Record<string, any>) {
  const f = FIXTURES[store]!;
  s().syncTable(store, [...Object.values(f.others?.() ?? {}), row], f.syncOpts);
}

function withField(row: Record<string, any>, field: string, value: unknown) {
  const out = { ...row, updated_at: 999 };
  if (value === undefined) delete out[field];
  else out[field] = value;
  return out;
}

const rowOf = (store: string) => s()[store][FIXTURES[store]!.id];
const locksOn = (store: string) => {
  const prefix = `${store}:${FIXTURES[store]!.id}`;
  return Object.keys(s().pending).filter((k) => (k === prefix || k.startsWith(`${prefix}:`)) && k !== `${prefix}:updated_at`);
};

let calls: Array<[string, unknown[]]> = [];
const owner = {};
beforeAll(() => {
  s()._setDispatch(async (action: string, args: unknown[]) => {
    calls.push([action, args]);
    return null;
  }, { owner });
});
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  calls = [];
});

describe("every writer has a fixture for every wire field", () => {
  it("fixtures cover UNDO_WRITERS and their wire tables", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(Object.keys(UNDO_WRITERS).sort());
    for (const [store, table] of Object.entries(UNDO_WIRE_TABLES)) {
      expect(Object.keys(FIXTURES[store]!.samples).sort()).toEqual(Object.keys(table).sort());
    }
  });
});

for (const [store, fixture] of Object.entries(FIXTURES)) {
  describe(`${store} writer`, () => {
    for (const [field, [prior, next]] of Object.entries(fixture.samples)) {
      for (const from of [prior, ABSENT] as Prior[]) {
        const uncaptured = fixture.uncaptured?.[field];
        const blocked = !!uncaptured || (from === ABSENT && UNDO_WIRE_TABLES[store]?.[field] === NO_CLEAR && !(field in (UNDO_WRITERS[store]?.clears ?? {})));
        const name = `${field}: ${from === ABSENT ? "unset" : "set"} → forward → undo`;
        it(blocked ? `${name} is not recorded (${uncaptured ?? "the server cannot clear it"})` : name, () => {
          const seeded = seedRow(store, field, from);
          fixture.forward(field, next);
          expect(rowOf(store)[field]).toEqual(next);
          if (blocked) {
            expect(getUndoHistory().items).toHaveLength(0);
            return;
          }
          expect(getUndoHistory().items).toHaveLength(1);
          // A push from before the server saw the edit does not take it back.
          push(store, seeded);
          expect(rowOf(store)[field]).toEqual(next);

          const restored = restoredValue(store, field, from);
          calls = [];
          expect(performUndo()).toBe(true);
          expect(rowOf(store)[field]).toEqual(restored);
          expect(calls.at(-1)).toEqual(fixture.expected(field, restored));

          // A push still carrying the forward value does not re-apply it.
          push(store, withField(seeded, field, next));
          expect(rowOf(store)[field]).toEqual(restored);

          // The server's echo of the undo: the row stays, and nothing is left locked.
          push(store, withField(seeded, field, restored));
          expect(rowOf(store)[field]).toEqual(restored);
          expect(locksOn(store)).toEqual([]);
        });
      }
    }
  });
}

describe("task writer specifics", () => {
  it("undoing an unassign sends the prior assignee", () => {
    seedRow("tasks", "assignee", "sam");
    s().updateTask("ct-1", { assignee: "" });
    expect(rowOf("tasks").assignee).toBe("");
    calls = [];
    performUndo();
    expect(rowOf("tasks").assignee).toBe("sam");
    expect(calls).toEqual([["updateTask", ["ct-1", { assignee: "sam" }]]]);
  });

  it("undoing a reopen of a parent closed over an open child closes it with only_parent", () => {
    const C1 = "1".repeat(32);
    useInboxStore.setState({
      tasks: {
        [T]: { _id: T, short_id: "ct-1", title: "Parent", status: "done", priority: "medium", updated_at: 1 },
        [C1]: { _id: C1, short_id: "ct-2", title: "Child", status: "todo", priority: "medium", parent_id: T, updated_at: 1 },
      },
      pending: {},
    } as any);
    s().updateTask("ct-1", { status: "todo" });
    calls = [];
    performUndo();
    expect(s().tasks[T].status).toBe("done");
    // The server refuses to close a parent with open subtasks unless told how.
    expect(calls).toEqual([["updateTask", ["ct-1", { status: "done", subtask_resolution: "only_parent" }]]]);
  });

  it("a cascade close undoes as one updateTask per closed row", () => {
    const C1 = "1".repeat(32);
    const C2 = "2".repeat(32);
    useInboxStore.setState({
      tasks: {
        [T]: { _id: T, short_id: "ct-1", title: "Parent", status: "in_progress", priority: "medium", updated_at: 1 },
        [C1]: { _id: C1, short_id: "ct-11", title: "Child", status: "todo", priority: "medium", parent_id: T, updated_at: 1 },
        [C2]: { _id: C2, short_id: "ct-12", title: "Child", status: "in_progress", priority: "medium", parent_id: T, updated_at: 1 },
      },
      pending: {},
    } as any);
    s().updateTask("ct-1", { status: "done", subtask_resolution: "cascade" });
    expect([T, C1, C2].map((id) => s().tasks[id].status)).toEqual(["done", "done", "done"]);
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Moved ct-1 and 2 subtasks to Done"]);
    calls = [];
    performUndo();
    expect([T, C1, C2].map((id) => s().tasks[id].status)).toEqual(["in_progress", "todo", "in_progress"]);
    expect(calls.filter(([a]) => a === "updateTask").map(([, args]) => args).sort((a: any, b: any) => a[0].localeCompare(b[0]))).toEqual([
      ["ct-1", { status: "in_progress" }],
      ["ct-11", { status: "todo" }],
      ["ct-12", { status: "in_progress" }],
    ]);
    // closed_at is the server's: the undo neither restores nor locks it.
    expect(Object.keys(s().pending).filter((k) => k.endsWith(":closed_at"))).toEqual([]);
  });

  it("updateTaskStatus rides the same writer, labeled by short id and status name", () => {
    seedRow("tasks", "status", "todo");
    s().updateTaskStatus("ct-1", "done");
    expect(getUndoHistory().items[0]!.label).toBe("Moved ct-1 to Done");
    calls = [];
    performUndo();
    expect(rowOf("tasks").status).toBe("todo");
    expect(calls).toEqual([["updateTask", ["ct-1", { status: "todo" }]]]);
  });

  it("closeTaskWithGuard and setTaskParent each record one entry through the same writer", () => {
    const C1 = "1".repeat(32);
    useInboxStore.setState({
      tasks: {
        [T]: { _id: T, short_id: "ct-1", title: "Parent", status: "in_progress", priority: "medium", updated_at: 1 },
        [C1]: { _id: C1, short_id: "ct-11", title: "Child", status: "todo", priority: "medium", parent_id: T, updated_at: 1 },
        [T_OTHER]: { _id: T_OTHER, short_id: "ct-3", title: "Other", status: "todo", priority: "medium", updated_at: 1 },
      },
      pending: {},
    } as any);

    // An open subtask parks the close behind the guard dialog: nothing is recorded yet.
    expect(closeTaskWithGuard("ct-1", "done").needsConfirm).toBe(true);
    expect(getUndoHistory().items).toHaveLength(0);
    resolveTaskCloseGuard("cascade");
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Moved ct-1 and 1 subtask to Done"]);
    performUndo();
    expect([T, C1].map((id) => s().tasks[id].status)).toEqual(["in_progress", "todo"]);

    _resetUndoStacks();
    expect(setTaskParent("ct-3", "ct-1").ok).toBe(true);
    expect(getUndoHistory().items.map((i) => i.label)).toEqual(["Moved ct-3 under ct-1"]);
    calls = [];
    performUndo();
    expect(s().tasks[T_OTHER].parent_id).toBeUndefined();
    expect(calls).toEqual([["updateTask", ["ct-3", { parent: "" }]]]);
  });
});

describe("bucket assignment writer", () => {
  it("a filing that created the assignment row is undone as an unfile", () => {
    useInboxStore.setState({ bucketAssignments: {}, pending: {} } as any);
    s().assignSessionToBucket(CONV, "bkt_a");
    calls = [];
    performUndo();
    expect(calls).toEqual([["assignSessionToBucket", [CONV, null]]]);
    // The row stays, unfiled, as it does on the server.
    expect(Object.values(s().bucketAssignments).filter((r: any) => r.conversation_id === CONV && r.bucket_id)).toEqual([]);
    expect(Object.values(s().pending).filter((e: any) => e.type === "exclude")).toEqual([]);
  });

  // The server never deletes an assignment row: an unfile keeps it with
  // bucket_id unset and the next filing reuses it. An undo that removed the
  // row would exclude that id, and every later push of it would be skipped.
  it("after the echo, an undone first filing keeps the server row, and a later filing of it shows", () => {
    const SRV = ASSIGNMENT;
    const assignments = () => Object.keys(s().pending).filter((k) => k.startsWith("bucketAssignments:"));
    useInboxStore.setState({ bucketAssignments: {}, pending: {} } as any);
    s().assignSessionToBucket(CONV, "bkt_a");
    // useSyncBuckets' push of the created row rekeys the stub onto it.
    s().syncTable("bucketAssignments", [{ _id: SRV, conversation_id: CONV, bucket_id: "bkt_a", updated_at: 2 }]);
    expect(Object.keys(s().bucketAssignments)).toEqual([SRV]);

    calls = [];
    expect(performUndo()).toBe(true);
    expect(calls).toEqual([["assignSessionToBucket", [CONV, null]]]);
    expect(s().bucketAssignments[SRV]).toMatchObject({ conversation_id: CONV });
    expect(s().bucketAssignments[SRV].bucket_id).toBeUndefined();
    expect(s().pending[`bucketAssignments:${SRV}`]).toBeUndefined();

    // A stale push still carrying the filing does not bring it back.
    s().syncTable("bucketAssignments", [{ _id: SRV, conversation_id: CONV, bucket_id: "bkt_a", updated_at: 2 }]);
    expect(s().bucketAssignments[SRV].bucket_id).toBeUndefined();
    // The echo of the unfile retires the undo's lock.
    s().syncTable("bucketAssignments", [{ _id: SRV, conversation_id: CONV, updated_at: 3 }]);
    expect(s().bucketAssignments[SRV].bucket_id).toBeUndefined();
    expect(assignments().filter((k) => !k.endsWith(":updated_at"))).toEqual([]);
    // Filed again from another device: the reused row shows here.
    s().syncTable("bucketAssignments", [{ _id: SRV, conversation_id: CONV, bucket_id: "bkt_b", updated_at: 4 }]);
    expect(s().bucketAssignments[SRV]).toMatchObject({ conversation_id: CONV, bucket_id: "bkt_b" });
    expect(assignments().filter((k) => s().pending[k].type === "exclude")).toEqual([]);
  });

  it("an undone first filing can be redone", () => {
    useInboxStore.setState({ bucketAssignments: {}, pending: {} } as any);
    s().assignSessionToBucket(CONV, "bkt_a");
    performUndo();
    calls = [];
    performRedo();
    expect(calls).toEqual([["assignSessionToBucket", [CONV, "bkt_a"]]]);
    expect(Object.values(s().bucketAssignments).map((r: any) => r.bucket_id)).toEqual(["bkt_a"]);
  });
});
