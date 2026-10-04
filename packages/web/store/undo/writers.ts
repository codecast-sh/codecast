// How an undo reaches the server for store keys off the patch rail.
//
// Keys with a registry dispatchTable (sessions, conversations, buckets,
// sessionDecisions) ride the engine's single applyUndoPatches pass. Every
// other local-first key needs a writer here, naming the existing action that
// carries a row's prior values to the server, or an entry in
// LOCAL_ONLY_UNDO_KEYS saying why it needs none. The guard test
// (store/__tests__/undoWriters.guard.test.ts) enforces it.
//
// A writer receives the row's prior values and turns them into that action's
// wire args. An unset prior value has to reach the server as a clear, and
// each server mutation spells a clear its own way, so every writable field is
// listed in a wire table with its clear: the value to send (a mutation that
// unsets on null or ""), or NO_CLEAR when the mutation cannot unset it. A
// field the mutation stores as a value rather than unsetting ("" for a task's
// cleared assignee) is also a `clears` entry, which the engine restores
// locally in place of the unset, so the row equals the server's echo. A
// gesture whose undo would need a NO_CLEAR clear is not recorded at all
// (undoBlockedByWire, read by the work policy's labels). Fields absent from a
// table are the server's to derive (closed_at, attempt_count, progress) and
// are never sent.
import type { CellChange, Invocation, UndoWriter } from "@platform/engine";
import { INITIATIVE_RECORD_LISTS } from "@codecast/shared/contracts/initiative";
import { recordOpsBetween } from "../initiativeRecord";

/** The mutation cannot unset this field once it holds a value. */
export const NO_CLEAR = Symbol("no-clear");

type WireTable = Record<string, unknown>;

// tasks.webUpdate (packages/convex/convex/tasks.ts): "" unsets status_id,
// execution_status, project_id, project_path, duplicate_of and parent; it
// stores "" for assignee and description and [] for labels (clears below);
// it ignores an empty priority, title or triage_status and has no clear for
// sort_order.
const TASK_WIRE: WireTable = {
  status: NO_CLEAR,
  status_id: "",
  priority: NO_CLEAR,
  title: NO_CLEAR,
  description: "",
  labels: [],
  assignee: "",
  triage_status: NO_CLEAR,
  execution_status: "",
  project_id: "",
  project_path: "",
  parent_id: "",
  sort_order: NO_CLEAR,
  duplicate_of: "",
};
const TASK_CLEARS = { assignee: "", description: "", labels: [] } as const;

// plans.webUpdate plus the charter (lib/orgCharter.ts charterPatch): the
// charter unsets on "", [] and null; the plan's own fields store [] as a
// value and cannot unset a title, status or project.
const PLAN_WIRE: WireTable = {
  title: NO_CLEAR,
  goal: "",
  acceptance_criteria: [],
  status: NO_CLEAR,
  task_ids: [],
  context_pointers: [],
  project_id: NO_CLEAR,
  success_metrics: [],
  priority: null,
  owner_role_id: null,
  non_goals: [],
};
const PLAN_CLEARS = { acceptance_criteria: [], task_ids: [], context_pointers: [] } as const;

// projects.webUpdate: null unsets the nullable fields and the charter; a
// plain string or list is stored as sent.
const PROJECT_WIRE: WireTable = {
  title: NO_CLEAR,
  description: "",
  status: NO_CLEAR,
  color: "",
  icon: "",
  target_date: null,
  labels: [],
  horizon: null,
  project_path: null,
  goal: "",
  success_metrics: [],
  priority: null,
  owner_role_id: null,
  non_goals: [],
  risks: [],
  budget: null,
};
const PROJECT_CLEARS = { description: "", color: "", icon: "", labels: [] } as const;

// initiatives.update (fieldsPatch): null unsets every optional field, an
// empty list unsets labels. project_ids travel through setProjects, and the
// intent record's four lists through initiatives.record, one entry at a time
// (recordOpsBetween), so neither is listed here.
const INITIATIVE_WIRE: WireTable = {
  title: NO_CLEAR,
  description: null,
  status: NO_CLEAR,
  owner: null,
  target_date: null,
  priority: null,
  labels: [],
  parent_initiative_id: null,
  metrics: [],
  why: null,
  done_when: null,
};

// dispatch.updateDoc stores what it is sent; pinDoc stores a boolean;
// docs.webMoveDoc unsets an absent parent and stores an absent rank as 0.
const DOC_FIELDS_WIRE: WireTable = { title: NO_CLEAR, doc_type: "", labels: [] };
const DOC_CLEARS = { doc_type: "", labels: [], pinned: false, sort_order: 0 } as const;

/** The wire table of every store a writer serves, by store key. */
export const UNDO_WIRE_TABLES: Record<string, WireTable> = {
  tasks: TASK_WIRE,
  plans: PLAN_WIRE,
  projects: PROJECT_WIRE,
  initiatives: INITIATIVE_WIRE,
  docs: { ...DOC_FIELDS_WIRE, pinned: false, parent_id: undefined, sort_order: 0 },
  // workflows.webUpsert takes the whole graph; a row always has one, so there
  // is no "no graph" to go back to.
  workflows: { nodes: NO_CLEAR },
};

/**
 * Prior values as wire args: only listed fields, each unset one as its clear.
 * A field that was unset and is unset still (a draft that wrote undefined
 * onto a row without it) has nothing to send.
 */
function toWire(fields: Record<string, unknown>, table: WireTable, row: any): Record<string, unknown> {
  const wire: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!(field in table)) continue;
    if (value != null) wire[field] = value;
    else if (row?.[field] != null && table[field] !== NO_CLEAR) wire[field] = table[field];
  }
  return wire;
}

/**
 * Whether undoing these changes would have to clear a field its server
 * mutation cannot unset. The undo would restore the row locally while the
 * server kept the forward value, so such a gesture is not recorded.
 */
export function undoBlockedByWire(changes: readonly CellChange[]): boolean {
  return changes.some((c) => {
    if (c.kind !== "protected" || c.field === undefined || c.before != null) return false;
    return UNDO_WIRE_TABLES[c.store]?.[c.field] === NO_CLEAR && !(c.field in (UNDO_WRITERS[c.store]?.clears ?? {}));
  });
}

const call = (action: string, ...args: unknown[]): Invocation => ({ action, args });
const nonEmpty = (wire: Record<string, unknown>) => Object.keys(wire).length > 0;

/** A task's short id, from its row id or short id; the server also resolves a raw row id. */
function taskRef(tasks: Record<string, any> | undefined, id: string): string {
  const row = tasks?.[id] ?? Object.values(tasks ?? {}).find((t: any) => t?._id === id || t?.short_id === id);
  return row?.short_id ?? id;
}

export const UNDO_WRITERS: Record<string, UndoWriter> = {
  // One updateTask per row, so a cascade close undoes as one call per child.
  tasks: {
    clears: TASK_CLEARS,
    fields: (_id, fields, row, state) => {
      if (!row?.short_id) return [];
      const { parent_id, ...rest } = toWire(fields, TASK_WIRE, row);
      const wire: Record<string, unknown> = "parent_id" in fields ? { ...rest, parent: parent_id ? taskRef(state?.tasks, String(parent_id)) : "" } : rest;
      // The server refuses to close a parent with open subtasks unless told
      // how. Each row is restored by its own call, so only_parent puts back
      // exactly this row's prior state.
      if (wire.status === "done" || wire.status === "dropped") wire.subtask_resolution = "only_parent";
      return nonEmpty(wire) ? [call("updateTask", row.short_id, wire)] : [];
    },
  },
  plans: {
    clears: PLAN_CLEARS,
    fields: (id, fields, row) => {
      const wire = toWire(fields, PLAN_WIRE, row);
      return nonEmpty(wire) ? [call("updatePlan", row?.short_id ?? id, wire)] : [];
    },
  },
  projects: {
    clears: PROJECT_CLEARS,
    fields: (id, fields, row) => {
      const wire = toWire(fields, PROJECT_WIRE, row);
      return nonEmpty(wire) ? [call("updateProject", id, wire)] : [];
    },
  },
  initiatives: {
    fields: (id, fields, row) => {
      const wire = toWire(fields, INITIATIVE_WIRE, row);
      const out: Invocation[] = nonEmpty(wire) ? [call("updateInitiative", id, wire)] : [];
      if (Array.isArray(fields.project_ids)) out.push(call("setInitiativeProjects", id, fields.project_ids));
      for (const list of INITIATIVE_RECORD_LISTS) {
        if (list in fields) for (const op of recordOpsBetween(list, row?.[list], fields[list] as any[] | undefined)) out.push(call("recordInitiativeEntry", id, op));
      }
      return out;
    },
  },
  // Each field group has its own server verb. A move always sends both the
  // parent and the rank, because webMoveDoc writes both.
  docs: {
    clears: DOC_CLEARS,
    fields: (id, fields, row) => {
      const out: Invocation[] = [];
      const wire = toWire(fields, DOC_FIELDS_WIRE, row);
      if (nonEmpty(wire)) out.push(call("updateDoc", id, wire));
      if ("pinned" in fields) out.push(call("pinDoc", id, fields.pinned === true));
      if ("parent_id" in fields || "sort_order" in fields) {
        const parent = "parent_id" in fields ? fields.parent_id : row?.parent_id;
        const rank = "sort_order" in fields ? fields.sort_order : row?.sort_order;
        out.push(call("moveDoc", id, parent ?? undefined, rank ?? undefined));
      }
      return out;
    },
    // restoreArchivedDoc only clears archived_at on the server; the overlay
    // puts the row (and its docDetails mirror) back here.
    restoreRow: (id) => [call("restoreArchivedDoc", id)],
  },
  // A project's customized line (saveLineWorkflow carries the whole row by
  // slug): the prior graph goes back as one save. A fork is a create, which
  // the policy never records, so a row always exists here.
  workflows: {
    fields: (_id, fields, row) => {
      if (!row?.slug || !("nodes" in fields || "edges" in fields)) return [];
      const prior = { ...row, ...fields };
      return [call("saveLineWorkflow", { slug: row.slug, name: prior.name, goal: prior.goal, source: prior.source, nodes: prior.nodes, edges: prior.edges })];
    },
  },
  // A conversation's filing: one row per conversation, so the prior bucket
  // (or none) is one assignSessionToBucket. A filing that created the row
  // arrives here as a bucket_id cell too (the spec's spell, policies/work.ts):
  // the row is unfiled, never removed, as it is on the server.
  bucketAssignments: {
    fields: (_id, fields, row) =>
      row?.conversation_id && "bucket_id" in fields
        ? [call("assignSessionToBucket", row.conversation_id, (fields.bucket_id as string | undefined) ?? null)]
        : [],
  },
};

/** Local-first keys off the patch rail that need no writer, with the reason. */
export const LOCAL_ONLY_UNDO_KEYS: Record<string, string> = {
  capabilityBindings: "Written only by bindCapability, a create; creates are never undoable.",
  decisionStacks:
    "Written by reorderStack and setStackPolicy, whose specs carry an inverse naming the prior order or policy; removeFromStack and the stack creates are never undoable.",
  handledDecisions:
    "A local mark of decisions this viewer answered: answerDecision is never undoable, and reopenDecision's undo rides the sessionDecisions patch rail, whose echo rebuilds the mark.",
  comments:
    "Written by resolveCommentThread and editComment, whose specs carry an inverse with the prior value; adds, deletes and agent asks are never undoable.",
  codeComments:
    "Written by resolveCodeCommentThread and editCodeComment, whose specs carry an inverse with the prior value; posts and deleteCodeComment are never undoable.",
  sessionReads: "Read state; never undoable.",
  agentTasks:
    "Owned triggers. triggerAction pause/resume, setTriggerInterval and editTrigger carry an inverse naming the opposite verb, the prior interval or the prior prompt and schedule; run now, cancel, reactivate and delete are never undoable.",
  foreignTriggers: "Triggers the viewer manages but does not own; the same verbs and inverses as agentTasks.",
  agentDefinitions: "Written only by deletes, which are never undoable.",
  agentChains: "Written only by deletes, which are never undoable.",
  issueSyncSources: "Integration settings (add, update, remove a source); settings are never undoable.",
  notifications: "Read state (mark read, mark all read); never undoable.",
  callRooms: "Live call controls (lock, transcription, recording) act on a call in progress; never undoable.",
  callRecordings:
    "A per-window view of a call's files, each carrying a URL signed for one window; written only by deleteCallRecording, a delete, never undoable.",
  callRecordingCalls:
    "A per-window view of a call's recording facts; written by setCallShareVideo, a sharing change, and deleteCallRecording's local mark, a delete; neither is undoable.",
  callFrameShares:
    "A per-window view of the pictures of a call on public links; written only by deleteCallFrameShare, which takes a picture off its link and is never undoable.",
  roomKnocks:
    "Who is waiting at the door right now; written only by admitGuestKnock, denyGuestKnock and removeCallGuest, answers to a person at the door that are never undoable.",
  teams: "Team create, delete and membership visibility are never undoable.",
  teamMembers: "Only the viewer's own presence status writes it, a setting; never undoable.",
  bookmarks: "toggleBookmark's spec carries an inverse (the same toggle), which reaches the server as the toggle itself.",
  pendingPermissions: "Written only by resolvePermission, an answer the agent acts on at once; never undoable.",
  workflowRuns: "Written only by respondToGate, a gate answer that resumes the run; never undoable.",
  currentUser: "Profile and preference settings; never undoable, and the undo binding ignores the key.",
  migrationBatches:
    "Written only by startResourceOffload and cancelResourceOffload, which start or cancel a migration batch on hosts; machine control is never undoable.",
  opsSources:
    "Written by createOpsSource, removeOpsSource and setOpsSourceStatus: a create, a delete and a setting, none of them undoable.",
  opsGroups:
    "Written only by setOpsGroupStatus, triage (resolve, ignore, reopen) on one status control; never undoable.",
};
