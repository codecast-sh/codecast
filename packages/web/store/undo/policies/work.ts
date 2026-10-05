// Undo policy for work objects: tasks, plans, projects, initiatives, docs,
// comments, stacks, bookmarks, saved views, triggers, chat, privacy and the
// org record.
//
// Two routes reach the server. Edits to a local-first collection off the
// patch rail (tasks, plans, projects, initiatives, docs, bucket assignments)
// go through that collection's writer (../writers.ts), so their specs here are
// labels only. Everything else names its server half as an inverse: the same
// action with the prior value, or the verb that takes the gesture back. An
// inverse reads its rows and prior values from ctx.changes, so a partial undo
// that skips a row sends nothing for it. Org verbs are display-only history
// items: the org record owns their undo.
//
// A label of null means the call is not recorded. Labels return null where an
// undo could not put the server back where it was (a field its mutation cannot
// clear, a prior state the inverse verb does not produce); each such case says
// why at its site.
import type { CellChange, Invocation, UndoCtx, UndoSpec } from "@platform/engine";
import { DEFAULT_TASK_STATUS_NAMES, teamTaskStatuses } from "@codecast/shared/tasks";
import { targetDayOf } from "@codecast/shared/time";
import { assigneeLabelOf, resolveAssigneeInfo } from "../../../lib/liveEntities";
import type { UndoPolicy } from "../policy";
import type { OrgReparentSessionTarget } from "../../orgSlice";
import { counted, quoted, sessionTitle } from "../labels";
import { isThinBefore, withSessionsPrior } from "../thinConversation";
import { undoBlockedByWire } from "../writers";

type Spec = { spec: UndoSpec };

const call = (action: string, ...args: unknown[]): Invocation => ({ action, args, runDraft: false });

const cellsOf = (ctx: UndoCtx, stores: string | readonly string[], field?: string): CellChange[] => {
  const keys = typeof stores === "string" ? [stores] : stores;
  return ctx.changes.filter((c) => keys.includes(c.store) && (field === undefined || c.field === field));
};

const rowIds = (cells: readonly CellChange[]): string[] => [...new Set(cells.map((c) => c.id))];

/** The writer route's label: null when the undo would need a clear the server cannot make. */
const viaWriter = (label: (ctx: UndoCtx) => string | null, extra?: Partial<UndoSpec>): Spec => ({
  spec: { label: (ctx) => (undoBlockedByWire(ctx.changes) ? null : label(ctx)), ...extra },
});

// ── Tasks ────────────────────────────────────────────────────────────────────

/** The team status a write picks (status_id), else its category's built-in name. */
function statusName(state: any, task: any, fields: Record<string, unknown>): string {
  const team = ((state?.teams ?? []) as any[]).find((t) => task?.team_id && String(t?._id) === String(task.team_id));
  const picked = fields.status_id ? teamTaskStatuses(team?.task_statuses).find((st) => st.id === fields.status_id) : undefined;
  return picked?.name ?? DEFAULT_TASK_STATUS_NAMES[fields.status as keyof typeof DEFAULT_TASK_STATUS_NAMES] ?? String(fields.status);
}

function assigneeName(state: any, assignee: string): string {
  const info = resolveAssigneeInfo(assignee, null, state?.teamMembers, state?.currentUser, state?.orgTree?.roles);
  return assigneeLabelOf(assignee, info);
}

/**
 * What a task write did, said of `subject` (a short id, or "3 tasks" for a
 * bulk edit): "Moved ct-123 to Done", "Assigned 3 tasks to Sam". A status move
 * says `moved`, which names a cascade's subtasks too. `task` is a row the
 * write touched, for its team's status names.
 */
export function taskEditLabel(state: any, task: any, subject: string, fields: Record<string, unknown>, moved = subject): string {
  if (fields.status !== undefined) return `Moved ${moved} to ${statusName(state, task, fields)}`;
  if (fields.duplicate_of !== undefined) {
    return fields.duplicate_of ? `Marked ${subject} as a duplicate of ${fields.duplicate_of}` : `Unmarked ${subject} as a duplicate`;
  }
  // A refinement rides along with its category; any other pair is an edit.
  if (Object.keys(fields).filter((k) => k !== "subtask_resolution" && k !== "status_id").length > 1) return `Edited ${subject}`;
  if (fields.assignee !== undefined) {
    return fields.assignee ? `Assigned ${subject} to ${assigneeName(state, String(fields.assignee))}` : `Unassigned ${subject}`;
  }
  if (fields.parent !== undefined) return fields.parent ? `Moved ${subject} under ${fields.parent}` : `Moved ${subject} to the top level`;
  if (fields.title !== undefined) return `Renamed ${subject}`;
  if (fields.priority !== undefined) return `Set ${subject} to ${fields.priority} priority`;
  if (fields.labels !== undefined) return `Changed the labels of ${subject}`;
  if (fields.sort_order !== undefined) return `Reordered ${subject}`;
  return `Edited ${subject}`;
}

/** One task's write, with "and N subtasks" when a status move cascaded. */
function taskLabel(ctx: UndoCtx, shortId: string, fields: Record<string, unknown>): string {
  const ownRows = Object.values(ctx.before?.tasks ?? {}).filter((t: any) => t?.short_id === shortId) as any[];
  const own = new Set(ownRows.map((t) => String(t._id)));
  const subtasks = rowIds(cellsOf(ctx, "tasks")).filter((id) => !own.has(id)).length;
  const moved = subtasks > 0 ? `${shortId} and ${counted(subtasks, "subtask")}` : shortId;
  return taskEditLabel(ctx.after, ownRows[0], shortId, fields, moved);
}

// closed_at and the attempt stamps are the server's to set: a reopen leaves
// the server's closed_at in place, so restoring the cached one locally would
// hold a lock its echo never matches.
const TASK_SERVER_STAMPS = ["closed_at", "attempt_count", "last_attempted_at"] as const;
// The description is edited in DocEditor, which owns its text undo (as the
// doc body is); a description-only save records nothing.
const TASK_UNCAPTURED = [...TASK_SERVER_STAMPS, "description"] as const;

// ── Plans, projects, initiatives, docs ───────────────────────────────────────

function editLabel(row: any, fields: Record<string, unknown>, noun: string): string {
  const name = quoted(row?.title, noun);
  if (fields.title !== undefined && fields.title !== row?.title) return `Renamed ${name} to ${quoted(String(fields.title), noun)}`;
  if (fields.status !== undefined) return `Marked ${name} ${String(fields.status).replace(/_/g, " ")}`;
  if (Object.keys(fields).length === 1 && "target_date" in fields) {
    const day = targetDayOf(fields.target_date as number | null);
    return day ? `Set the target of ${name} to ${day}` : `Cleared the target of ${name}`;
  }
  return `Edited ${name}`;
}

const planOf = (state: any, ref: string) =>
  Object.values(state?.plans ?? {}).find((p: any) => p?.short_id === ref || p?._id === ref) as any;
const projectOf = (state: any, id: string) => state?.projects?.[id] ?? Object.values(state?.projects ?? {}).find((p: any) => p?._id === id);

// An initiative owned by a role has its projects in that role's scope: the
// server widens the scope in the write's own transaction and logs it in the
// org record (initiatives.ts coverOwnerScope), and the role may take over the
// sessions it gained. No initiative verb takes that back, so a gesture that
// widened a role's scope is not recorded: its undo would restore the
// initiative and leave the role holding the scope. The org record owns it, as
// it does for setProjectLead. The draft paints the gain on orgTree and
// orgIntents by the server's rule, so with the tree loaded those cells say
// whether the scope grew. Without the tree, any write that names a role owner
// or adds a project under one is taken to have grown it.
const ORG_STORES = ["orgTree", "orgIntents"] as const;
function widenedRoleScope(ctx: UndoCtx): boolean {
  if (cellsOf(ctx, ORG_STORES).length > 0) return true;
  if (ctx.after?.orgTree) return false;
  const id = ctx.args[0] as string;
  const now = ctx.after?.initiatives?.[id];
  if (now?.owner?.kind !== "role" || !now.project_ids?.length) return false;
  const was = ctx.before?.initiatives?.[id];
  const sameOwner = was?.owner?.kind === "role" && was.owner.role_id === now.owner.role_id;
  return !sameOwner || now.project_ids.some((p: string) => !(was?.project_ids ?? []).includes(p));
}
const viaInitiativeWriter = (label: (ctx: UndoCtx) => string, extra?: Partial<UndoSpec>): Spec =>
  viaWriter((ctx) => (widenedRoleScope(ctx) ? null : label(ctx)), extra);

type RecordOpLike = { list: string; action: string };
const RECORD_NOUN: Record<string, string> = { milestones: "milestone", questions: "question", decisions: "decision", sources: "source" };
/** "Reached a milestone of “X”", "Answered a question on “X”", "Added a source to “X”". */
function recordLabel(op: RecordOpLike, goal: string): string {
  const noun = RECORD_NOUN[op?.list] ?? "entry";
  if (op?.action === "close") return op.list === "questions" ? `Answered a question on ${goal}` : `Reached a milestone of ${goal}`;
  if (op?.action === "add") return `Added a ${noun} to ${goal}`;
  if (op?.action === "remove") return `Removed a ${noun} from ${goal}`;
  return `Edited a ${noun} of ${goal}`;
}

const docTitle = (state: any, id: string) => quoted(state?.docs?.[id]?.title ?? state?.docDetails?.[id]?.title, "doc");

// The docs writer reaches the server from a cell of the `docs` list. A doc
// held only in docDetails (opened by link before the list lands, or from
// another workspace) has no such cell, so its undo would restore the detail
// row and send nothing: the gesture is not recorded.
const viaDocsWriter = (label: (ctx: UndoCtx) => string, extra?: Partial<UndoSpec>): Spec =>
  viaWriter((ctx) => (ctx.changes.some((c) => c.store === "docs" && c.kind === "protected" && c.field !== "updated_at") ? label(ctx) : null), extra);

// The server never deletes an assignment row: an unfile keeps it with
// bucket_id unset and the next filing reuses it. So the undo of a filing that
// created the row ends there too, as a bucket_id cell with no prior value.
// Deleting the row would leave an exclude on the server row's id, and this
// delta collection would then skip every later push of it.
const spellFirstFiling = (cells: CellChange[]): CellChange[] =>
  cells.map((c) =>
    c.store === "bucketAssignments" && c.field === undefined && !c.hadBefore && c.hadAfter
      ? { ...c, field: "bucket_id", before: undefined, after: (c.after as { bucket_id?: string } | undefined)?.bucket_id }
      : c,
  );

// ── Conversations: privacy and project ───────────────────────────────────────

const CONV_STORES = ["conversations", "sessions"] as const;

/** A conversation field's prior value, from the cells that changed it (either store copy). */
function priorOf(ctx: UndoCtx, id: string, field: string): unknown {
  const cells = ctx.changes.filter((c) => c.id === id && c.field === field && (CONV_STORES as readonly string[]).includes(c.store));
  const known = cells.find((c) => c.before !== undefined) ?? cells[0];
  return known ? known.before : rowBefore(ctx, id)?.[field];
}

const rowBefore = (ctx: UndoCtx, id: string) => ctx.before?.conversations?.[id] ?? ctx.before?.sessions?.[id];

const convIds = (ctx: UndoCtx, fields: readonly string[]) =>
  rowIds(ctx.changes.filter((c) => (CONV_STORES as readonly string[]).includes(c.store) && c.field !== undefined && fields.includes(c.field)));

// The server's setPrivacy(true) stamps team_visibility "private", and its
// setPrivacy(false) keeps whatever visibility the row has; setTeamVisibility
// shares and names the level. So a row that was shared returns through
// setTeamVisibility with its prior level, and a row that was private returns
// through setPrivacy(true).
function restorePrivacy(ctx: UndoCtx): Invocation[] {
  return convIds(ctx, ["is_private", "team_visibility"]).map((id) =>
    priorOf(ctx, id, "is_private") === true
      ? call("setPrivacy", id, true)
      : call("setTeamVisibility", id, (priorOf(ctx, id, "team_visibility") as string | undefined) ?? null),
  );
}

// Whether the inverse can put the server back where it was. Sharing assigns a
// team to a conversation that has none (privacy.ts buildShareUpdate) and no
// verb takes a team away, so a row that was shared with no team cannot be
// returned to: the undo would show it to a team that never saw it. The same
// holds when the prior is_private is unknown here (a row without the field),
// which restorePrivacy would read as shared. Such gestures are not recorded.
const privacyRestorable = (ctx: UndoCtx): boolean =>
  convIds(ctx, ["is_private", "team_visibility"]).every((id) => {
    const prior = priorOf(ctx, id, "is_private");
    return prior === true || (prior === false && rowBefore(ctx, id)?.team_id != null);
  });

// On a row with no loaded meta, these inverses cannot restore a conversations
// cell with no prior value as a clear: the thin row says nothing about what
// the field held, so a lock for an absent value would never meet its echo and
// would strip the field from the meta when it syncs. The prior value is the
// inbox row's: each such cell takes the before value of the sessions cell for
// the same field, and is dropped where the inbox row did not change, so
// nothing is written or locked for it. A row whose meta was loaded keeps the
// cell: there the field really was unset, and the inverse returns it to that
// (setTeamVisibility(id, null) clears the level).
const spellThinConversation = (cells: CellChange[], ctx?: UndoCtx): CellChange[] =>
  cells.flatMap((c) =>
    c.store !== "conversations" || c.field === undefined || c.hadBefore || !isThinBefore(ctx, c.id) ? [c] : (withSessionsPrior(cells, c) ?? []),
  );

// setPrivacy(true) stores team_visibility "private" even on a row born
// private with none, so an undo back to private writes that spelling and its
// lock retires on the echo.
const spellPrivacy = (all: CellChange[], ctx?: UndoCtx): CellChange[] => {
  const cells = spellThinConversation(all, ctx);
  return cells.map((c) =>
    c.field === "team_visibility" && c.before == null && priorPrivate(cells, c.id)
      ? { ...c, before: "private", hadBefore: true }
      : c,
  );
};

// The server's switchProject stores git_root = the path it is given, so an
// undo back to a prior project_path writes that path as git_root too, even
// when the row's prior git_root was a parent directory or unset.
const spellSwitchProject = (all: CellChange[], ctx?: UndoCtx): CellChange[] => {
  const cells = spellThinConversation(all, ctx);
  return cells.map((c) => {
    if (c.field !== "git_root") return c;
    const prior = cells.find((p) => p.id === c.id && p.store === c.store && p.field === "project_path")?.before;
    return typeof prior === "string" ? { ...c, before: prior, hadBefore: true } : c;
  });
};

const priorPrivate = (cells: readonly CellChange[], id: string) =>
  cells.some((c) => c.id === id && c.field === "is_private" && c.before === true);

/**
 * Who can see a row, ordered: private, then a summary, then everything. A
 * shared row with no level of its own falls back to its owner's membership
 * level, which can sit on either side of the others, so it is its own value.
 */
function audience(isPrivate: unknown, visibility: unknown): number | "default" {
  if (visibility === "full") return 2;
  if (visibility === "summary") return 1;
  return isPrivate === true || visibility === "private" ? 0 : "default";
}

const rowNow = (ctx: UndoCtx, id: string) => ctx.after?.conversations?.[id] ?? ctx.after?.sessions?.[id];

// Undo widens access when the prior audience is wider than the one the
// gesture left, or when the two cannot be ordered (the member default).
function undoWidens(ctx: UndoCtx): boolean {
  return convIds(ctx, ["is_private", "team_visibility"]).some((id) => {
    const prior = audience(priorOf(ctx, id, "is_private"), priorOf(ctx, id, "team_visibility"));
    const now = audience(rowNow(ctx, id)?.is_private, rowNow(ctx, id)?.team_visibility);
    if (prior === now || prior === 0) return false;
    return now === 0 || prior === "default" || now === "default" || prior > now;
  });
}

const visibilityName = (v: unknown) => (v === "full" ? "full" : v === "summary" ? "summary" : "default");

// ── Comments, stacks, triggers ───────────────────────────────────────────────

const stackTitle = (state: any, id: string) => quoted(state?.decisionStacks?.[id]?.title, "stack");

type TriggerVerb = "pause" | "resume" | "runNow" | "cancel" | "reactivate";
const TRIGGER_STORES = ["agentTasks", "foreignTriggers"] as const;
const triggerRow = (state: any, id: string) => state?.agentTasks?.[id] ?? state?.foreignTriggers?.[id];
const triggerTitle = (state: any, id: string) => {
  const t = triggerRow(state, id);
  return quoted(t?.display_title || t?.title || t?.prompt, "trigger");
};

/**
 * The verbs that take a trigger verb back, given the status before it.
 * Pause works on a scheduled trigger and resume returns it to scheduled.
 * Nothing else is taken back: run now has run, reactivate has re-armed, and
 * cancel ends the trigger (reactivating re-arms a recurring one an interval
 * from now, not at its slot).
 */
function triggerInverse(verb: TriggerVerb, prior: unknown): string[] | null {
  if (verb === "pause") return prior === "scheduled" ? ["resume"] : null;
  if (verb === "resume") return prior === "paused" ? ["pause"] : null;
  return null;
}

const priorStatus = (ctx: UndoCtx, id: string) =>
  ctx.changes.find((c) => c.id === id && c.field === "status" && (TRIGGER_STORES as readonly string[]).includes(c.store))?.before;

const TRIGGER_TEXT_FIELDS = ["prompt", "title", "mode", "agent_type"] as const;

/** A trigger's prior values for the fields an edit named (TriggerEdit). */
function priorTriggerFields(prior: any, edited: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TRIGGER_TEXT_FIELDS) if (k in edited && prior[k] != null) out[k] = prior[k];
  if ("project_path" in edited) out.project_path = prior.project_path ?? "";
  if ("schedule_type" in edited || "interval_ms" in edited || "run_at" in edited) {
    out.schedule_type = prior.schedule_type;
    if (prior.schedule_type === "recurring") out.interval_ms = prior.interval_ms;
    if (prior.schedule_type === "event") out.event_filter = prior.event_filter;
    if (prior.schedule_type !== "event" && typeof prior.run_at === "number" && prior.run_at > Date.now()) out.run_at = prior.run_at;
  }
  return out;
}

function formatInterval(ms: number): string {
  const units: Array<[number, string]> = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"]];
  for (const [size, unit] of units) if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  return `${Math.round(ms / 60_000)}m`;
}

// ── Chat ─────────────────────────────────────────────────────────────────────

const channelName = (state: any, id: string) => `#${state?.chatChannels?.[id]?.name ?? "channel"}`;
const railMembers = (state: any, channelId: string): string[] =>
  ((state?.chatRail ?? []) as any[]).find((r) => String(r?.channel_id) === channelId)?.member_ids?.map(String) ?? [];
const personName = (state: any, id: string) => assigneeName(state, id);
const teamRow = (state: any, id: string): any => (state?.teams ?? []).find((t: any) => t?._id === id);

// ── Org ──────────────────────────────────────────────────────────────────────

const roleName = (state: any, id: string) =>
  quoted(((state?.orgTree?.roles ?? []) as any[]).find((r) => String(r?._id) === id)?.name, "role");
const org = (label: (ctx: UndoCtx) => string): Spec => ({ spec: { label, external: "org" } });

// The owners chip, the handoff composer and the chart all move a session
// through reparentOrgSession. The label says which gesture it was, in the
// words the chip's own toast uses (hooks/useOwners).
function reparentSessionLabel(ctx: UndoCtx): string {
  const session = sessionTitle(ctx.before, ctx.args[0] as string);
  const target = ctx.args[1] as OrgReparentSessionTarget | undefined;
  if (target?.kind === "role") return `Filed ${session} under ${roleName(ctx.before, target.role_id)}`;
  const owners = target?.owners;
  if (target?.kind !== "user" || !owners) {
    return target?.kind === "user" && target.user_id ? `Moved ${session} under ${personName(ctx.before, target.user_id)}` : `Moved ${session} in the org`;
  }
  const names = owners.map((id) => personName(ctx.before, id)).join(", ");
  if (target.mode === "add") return `Made ${names} ${owners.length === 1 ? "an owner" : "owners"} of ${session}`;
  if (target.mode === "remove") return `Removed ${names} from ${session}`;
  // The named person goes last in a handoff's owner set (handoffOwnerSet).
  return owners.length ? `Handed ${session} off to ${personName(ctx.before, owners[owners.length - 1]!)}` : `Cleared the owners of ${session}`;
}

export const WORK_UNDO_POLICY: UndoPolicy = {
  // ── Tasks (writer: updateTask per row) ─────────────────────────────────────
  // Rapid edits of the same fields (priority cycling, a title committed per
  // keystroke) merge into one entry.
  updateTask: viaWriter((ctx) => taskLabel(ctx, ctx.args[0] as string, (ctx.args[1] ?? {}) as Record<string, unknown>), {
    ignoreFields: TASK_UNCAPTURED,
    coalesce: true,
  }),
  updateTaskStatus: viaWriter((ctx) => taskLabel(ctx, ctx.args[0] as string, { status: ctx.args[1] }), {
    ignoreFields: TASK_SERVER_STAMPS,
  }),

  // ── Plans, projects, initiatives (writers: their update verbs) ─────────────
  updatePlan: viaWriter((ctx) => editLabel(planOf(ctx.before, ctx.args[0] as string), ctx.args[1] as Record<string, unknown>, "plan"), {
    coalesce: true,
  }),
  updateProject: viaWriter((ctx) => editLabel(projectOf(ctx.before, ctx.args[0] as string), ctx.args[1] as Record<string, unknown>, "project"), {
    coalesce: true,
  }),
  // Not recorded when the gesture widened the owner role's scope (see
  // widenedRoleScope); removing a project never does.
  // The target date picker writes once per input event (a typed year is four
  // writes), so rapid edits of one field merge as they do for plans.
  updateInitiative: viaInitiativeWriter(
    (ctx) => editLabel(ctx.before?.initiatives?.[ctx.args[0] as string], (ctx.args[1] ?? {}) as Record<string, unknown>, "initiative"),
    { coalesce: true },
  ),
  addInitiativeProject: viaInitiativeWriter(
    (ctx) => `Added ${quoted(projectOf(ctx.before, ctx.args[1] as string)?.title, "project")} to ${quoted(ctx.before?.initiatives?.[ctx.args[0] as string]?.title, "initiative")}`,
  ),
  removeInitiativeProject: viaWriter(
    (ctx) => `Removed ${quoted(projectOf(ctx.before, ctx.args[1] as string)?.title, "project")} from ${quoted(ctx.before?.initiatives?.[ctx.args[0] as string]?.title, "initiative")}`,
  ),
  // One entry of the intent record: the writer sends the entry's prior state
  // back by key (recordOpsBetween), so an undo never replaces the list.
  recordInitiativeEntry: viaWriter((ctx) => recordLabel(ctx.args[1] as RecordOpLike, quoted(ctx.before?.initiatives?.[ctx.args[0] as string]?.title, "initiative"))),
  setInitiativeProjects: viaInitiativeWriter((ctx) => `Reordered the projects of ${quoted(ctx.before?.initiatives?.[ctx.args[0] as string]?.title, "initiative")}`),
  // Naming a lead also widens the role's scope in the org record, in one
  // server transaction (orgRoles.setProjectLead); the org record owns its undo.
  setProjectLead: org((ctx) =>
    ctx.args[1]
      ? `Made ${roleName(ctx.before, ctx.args[1] as string)} lead of ${quoted(projectOf(ctx.before, ctx.args[0] as string)?.title, "project")}`
      : `Cleared the lead of ${quoted(projectOf(ctx.before, ctx.args[0] as string)?.title, "project")}`,
  ),

  // ── Docs (writer: updateDoc, pinDoc, moveDoc, restoreArchivedDoc) ──────────
  // The editor owns text undo; a content-only save records nothing.
  updateDoc: viaDocsWriter(
    (ctx) => {
      const fields = (ctx.args[1] ?? {}) as Record<string, unknown>;
      const title = docTitle(ctx.before, ctx.args[0] as string);
      return fields.title !== undefined && fields.title !== ctx.before?.docs?.[ctx.args[0] as string]?.title
        ? `Renamed ${title} to ${quoted(String(fields.title), "doc")}`
        : `Edited ${title}`;
    },
    { ignoreFields: ["content", "overflow"] },
  ),
  pinDoc: viaDocsWriter((ctx) => `${ctx.args[1] ? "Starred" : "Unstarred"} ${docTitle(ctx.before, ctx.args[0] as string)}`),
  moveDoc: viaDocsWriter((ctx) => `Moved ${docTitle(ctx.before, ctx.args[0] as string)}`),
  archiveDoc: viaDocsWriter((ctx) => `Archived ${docTitle(ctx.before, ctx.args[0] as string)}`, { toast: true }),

  // ── Inbox filing and project ───────────────────────────────────────────────
  assignSessionToBucket: viaWriter(
    (ctx) => {
      const [conv, bucket] = ctx.args as [string, string | null];
      return bucket
        ? `Labeled ${sessionTitle(ctx.before, conv)} ${quoted(ctx.before?.buckets?.[bucket]?.name, "label")}`
        : `Removed the label from ${sessionTitle(ctx.before, conv)}`;
    },
    { spell: spellFirstFiling },
  ),
  // The project path rides an action of its own on the server.
  switchProject: {
    spec: {
      label: (ctx) => {
        const [id, path] = ctx.args as [string, string];
        if (typeof priorOf(ctx, id, "project_path") !== "string") return null;
        return `Moved ${sessionTitle(ctx.before, id)} to ${path.replace(/\/+$/, "").split("/").pop() || path}`;
      },
      inverse: (ctx) =>
        convIds(ctx, ["project_path"]).flatMap((id) => {
          const prior = priorOf(ctx, id, "project_path");
          return typeof prior === "string" ? [call("switchProject", id, prior)] : [];
        }),
      spell: spellSwitchProject,
    },
  },

  // ── Privacy (immutable on the patch rail, so an inverse) ───────────────────
  // An undo that would widen who sees the session is offered only from the
  // toast and the timeline; blind ⌘Z stops at it. One that narrows (taking
  // back an accidental share) is an ordinary undo.
  setPrivacy: {
    spec: {
      label: (ctx) =>
        privacyRestorable(ctx)
          ? `${ctx.args[1] ? "Made" : "Shared"} ${sessionTitle(ctx.before, ctx.args[0] as string)}${ctx.args[1] ? " private" : " with the team"}`
          : null,
      inverse: restorePrivacy,
      spell: spellPrivacy,
      confirm: undoWidens,
      toast: true,
    },
  },
  setTeamVisibility: {
    spec: {
      label: (ctx) =>
        privacyRestorable(ctx) ? `Set ${sessionTitle(ctx.before, ctx.args[0] as string)} to ${visibilityName(ctx.args[1])} team visibility` : null,
      inverse: restorePrivacy,
      spell: spellPrivacy,
      confirm: undoWidens,
      toast: true,
    },
  },

  // ── Bookmarks, saved views, comments ───────────────────────────────────────
  // The server half is the toggle itself; the guard has already checked the
  // bookmark is still where the gesture left it.
  toggleBookmark: {
    spec: {
      label: (ctx) => (cellsOf(ctx, "bookmarks").some((c) => c.hadAfter) ? "Bookmarked a message" : "Removed a bookmark"),
      inverse: (ctx) => rowIds(cellsOf(ctx, "bookmarks")).map((messageId) => call("toggleBookmark", ctx.args[0], messageId)),
    },
  },
  // savedViews is not local-first, so its cells are mirrors with no writer:
  // the inverse sends the prior fields. savedViews.webUpdate cannot unset a
  // field, so an edit that gave the view one it did not have (a first icon,
  // color or team) is not recorded: its undo could not reach the server.
  // A share toggle names itself, and the undo of stopping sharing (which
  // shares the view with the team again) asks first, as a widening privacy
  // undo does.
  updateSavedView: {
    spec: {
      label: (ctx) => {
        const cells = cellsOf(ctx, "savedViews");
        if (cells.some((c) => c.field !== "updated_at" && c.before === undefined)) return null;
        const name = quoted(ctx.before?.savedViews?.[ctx.args[0] as string]?.name, "view");
        const shared = cells.find((c) => c.field === "shared");
        if (shared) return shared.after ? `Shared view ${name} with the team` : `Stopped sharing view ${name}`;
        return `Edited view ${name}`;
      },
      confirm: (ctx) => cellsOf(ctx, "savedViews").some((c) => c.field === "shared" && !!c.before && !c.after),
      inverse: (ctx) =>
        rowIds(cellsOf(ctx, "savedViews")).flatMap((id) => {
          const fields: Record<string, unknown> = {};
          for (const c of cellsOf(ctx, "savedViews")) {
            if (c.id === id && c.field && c.field !== "updated_at") fields[c.field] = c.before;
          }
          return Object.keys(fields).length ? [call("updateSavedView", id, fields)] : [];
        }),
    },
  },
  // A mod object's edit sends back the prior fields. `fields` merges on the
  // server, so an edit that added a field the object did not have is not
  // recorded: putting the old object back could not remove the new key.
  updateModObject: {
    spec: {
      label: (ctx) => {
        const cells = cellsOf(ctx, "modObjects").filter((c) => c.field !== "updated_at");
        if (!cells.length || cells.some((c) => c.before === undefined)) return null;
        const before = ctx.before?.modObjects?.[ctx.args[0] as string];
        const added = ctx.args[1] && typeof ctx.args[1] === "object" ? Object.keys(((ctx.args[1] as any).fields ?? {}) as object).filter((k) => !(k in (before?.fields ?? {}))) : [];
        return added.length ? null : `Edited ${quoted(before?.short_id ?? before?.title, "object")}`;
      },
      inverse: (ctx) =>
        rowIds(cellsOf(ctx, "modObjects")).flatMap((id) => {
          const patch: Record<string, unknown> = {};
          for (const c of cellsOf(ctx, "modObjects")) {
            if (c.id === id && c.field && c.field !== "updated_at") patch[c.field] = c.before;
          }
          return Object.keys(patch).length ? [call("updateModObject", id, patch)] : [];
        }),
    },
  },
  // Resolving is undone by reopening. Reopening is not recorded: re-resolving
  // stamps a fresh resolved_at on the server, which the cached stamp an undo
  // restores never matches, so its lock would never retire. For the same
  // reason a resolve over a thread holding an older resolved comment is not
  // recorded: the server's reopen clears that comment's stamp too.
  resolveCommentThread: {
    spec: {
      label: (ctx) =>
        ctx.args[2] && !cellsOf(ctx, "comments", "resolved_at").some((c) => c.before != null) ? "Resolved a comment thread" : null,
      inverse: (ctx) => {
        const [conv, anchor] = ctx.args as [string, unknown];
        // The thread is one server call: if a comment in it changed since,
        // the undo cannot leave that one out, so it is refused whole.
        const resolved = Object.values(ctx.after?.comments ?? {}).filter(
          (c: any) => c?.conversation_id === conv && c.resolved_at !== ctx.before?.comments?.[c._id]?.resolved_at,
        );
        const changed = new Set(rowIds(cellsOf(ctx, "comments", "resolved_at")));
        if (changed.size === 0 || resolved.some((c: any) => !changed.has(String(c._id)))) return null;
        return [call("resolveCommentThread", conv, anchor, false)];
      },
    },
  },
  // A code review thread: the flag flips both ways, and the server's call
  // settles the whole thread, so the undo names the rows that flipped and is
  // refused whole if one of them changed since.
  resolveCodeCommentThread: {
    spec: {
      label: (ctx) => (ctx.args[1] ? "Resolved a review thread" : "Reopened a review thread"),
      inverse: (ctx) => {
        const [ids, resolved] = ctx.args as [string[], boolean];
        const flipped = ids.filter((id) => ctx.before?.codeComments?.[id]?.resolved !== ctx.after?.codeComments?.[id]?.resolved);
        const changed = new Set(rowIds(cellsOf(ctx, "codeComments", "resolved")));
        if (changed.size === 0 || flipped.some((id) => !changed.has(id))) return null;
        return [call("resolveCodeCommentThread", ids.filter((id) => changed.has(id)), !resolved)];
      },
    },
  },
  editCodeComment: {
    spec: {
      label: () => "Edited a review comment",
      inverse: (ctx) =>
        cellsOf(ctx, "codeComments", "content").map((c) => call("editCodeComment", c.id, typeof c.before === "string" ? c.before : "")),
    },
  },
  editComment: {
    spec: {
      label: () => "Edited a comment",
      inverse: (ctx) =>
        // The draft runs: its returned payload is the receipt the side effect reads.
        cellsOf(ctx, "comments", "content").map((c) => ({
          action: "editComment",
          args: [c.id, typeof c.before === "string" ? c.before : ((ctx.result as any)?.previousContent ?? "")],
        })),
    },
  },

  // ── Decision stacks ────────────────────────────────────────────────────────
  reorderStack: {
    spec: {
      label: (ctx) => `Reordered ${stackTitle(ctx.before, ctx.args[0] as string)}`,
      inverse: (ctx) => cellsOf(ctx, "decisionStacks", "decision_ids").map((c) => call("reorderStack", c.id, c.before)),
    },
  },
  // The prior policy as a patch: each key the gesture moved goes back to its
  // value, or is cleared where it had none. A delegate-only write paints
  // nothing locally and records nothing.
  setStackPolicy: {
    spec: {
      label: (ctx) => `Changed the timing of ${stackTitle(ctx.before, ctx.args[0] as string)}`,
      inverse: (ctx) =>
        cellsOf(ctx, "decisionStacks", "policy").map((c) => {
          const before = (c.before ?? {}) as Record<string, unknown>;
          const after = (c.after ?? {}) as Record<string, unknown>;
          const patch: Record<string, unknown> = {};
          if (before.auto_default_after_ms !== after.auto_default_after_ms) {
            if (before.auto_default_after_ms === undefined) patch.clear_auto_default = true;
            else patch.auto_default_after_ms = before.auto_default_after_ms;
          }
          if (before.due_at !== after.due_at) {
            if (before.due_at === undefined) patch.clear_due = true;
            else patch.due_at = before.due_at;
          }
          return call("setStackPolicy", c.id, patch);
        }),
    },
  },

  // ── Triggers ───────────────────────────────────────────────────────────────
  // Pause and resume go back through the opposite verb (see triggerInverse).
  // Run now, reactivate and cancel are not recorded. The verbs run without their
  // drafts: the overlay puts the status back, and run_at is the server's to
  // recompute.
  triggerAction: {
    spec: {
      label: (ctx) => {
        const [id, verb] = ctx.args as [string, TriggerVerb];
        if (!triggerInverse(verb, priorStatus(ctx, id))) return null;
        const done = { pause: "Paused", resume: "Resumed" }[verb as "pause" | "resume"];
        return `${done} ${triggerTitle(ctx.before, id)}`;
      },
      inverse: (ctx) => {
        const verb = ctx.args[1] as TriggerVerb;
        return rowIds(cellsOf(ctx, TRIGGER_STORES, "status")).flatMap((id) =>
          (triggerInverse(verb, priorStatus(ctx, id)) ?? []).map((v) => call("triggerAction", id, v)),
        );
      },
      toast: true,
    },
  },
  // The draft runs so run_at lands where the server's applyTaskUpdate puts it
  // for the prior interval; the captured run_at is left out for that reason.
  setTriggerInterval: {
    spec: {
      label: (ctx) => `Set ${triggerTitle(ctx.before, ctx.args[0] as string)} to every ${formatInterval(ctx.args[1] as number)}`,
      inverse: (ctx) =>
        cellsOf(ctx, TRIGGER_STORES, "interval_ms").map((c) => ({ action: "setTriggerInterval", args: [c.id, c.before] })),
      ignoreFields: ["run_at"],
    },
  },
  // The inverse sends the prior value of every field the edit named. A
  // schedule goes back whole: its type with the cadence or event it ran on.
  // A past run_at is left to the server (an interval from now), like the
  // interval verb above.
  editTrigger: {
    spec: {
      label: (ctx) => `Edited ${triggerTitle(ctx.before, ctx.args[0] as string)}`,
      inverse: (ctx) => {
        const [id, fields] = ctx.args as [string, Record<string, unknown>];
        if (!ctx.changes.some((c) => c.id === id && (TRIGGER_STORES as readonly string[]).includes(c.store))) return [];
        const prior = triggerRow(ctx.before, id);
        if (!prior) return [];
        return [{ action: "editTrigger", args: [id, priorTriggerFields(prior, fields)] }];
      },
      ignoreFields: ["run_at"],
    },
  },

  // ── Chat (no local-first rows; the inverses carry the server half) ─────────
  updateChatChannel: {
    spec: {
      label: (ctx) => {
        const [id, fields] = ctx.args as [string, { name?: string; topic?: string }];
        const after = ctx.after?.chatChannels?.[id]?.name;
        if (fields.name !== undefined && after !== ctx.before?.chatChannels?.[id]?.name) return `Renamed ${channelName(ctx.before, id)} to #${after}`;
        return `Changed the topic of ${channelName(ctx.before, id)}`;
      },
      inverse: (ctx) =>
        rowIds(cellsOf(ctx, "chatChannels")).flatMap((id) => {
          const fields: Record<string, unknown> = {};
          for (const c of cellsOf(ctx, "chatChannels")) {
            if (c.id !== id) continue;
            if (c.field === "name" && typeof c.before === "string") fields.name = c.before;
            if (c.field === "topic") fields.topic = c.before ?? "";
          }
          return Object.keys(fields).length ? [call("updateChatChannel", id, fields)] : [];
        }),
    },
  },
  archiveChatChannel: {
    spec: {
      label: (ctx) => `${ctx.args[1] ? "Archived" : "Unarchived"} ${channelName(ctx.before, ctx.args[0] as string)}`,
      inverse: (ctx) =>
        cellsOf(ctx, "chatChannels", "archived_at").map((c) => call("archiveChatChannel", c.id, c.before != null)),
      toast: true,
    },
  },
  // Taking an add back removes each person the add brought in; re-adding a
  // removed person notifies them, as any add does.
  addChatChannelMembers: {
    spec: {
      label: (ctx) => {
        const [id] = ctx.args as [string];
        const added = railMembers(ctx.after, id).filter((m) => !railMembers(ctx.before, id).includes(m));
        if (added.length === 0) return null;
        return `Added ${added.length === 1 ? personName(ctx.after, added[0]!) : `${added.length} people`} to ${channelName(ctx.before, id)}`;
      },
      inverse: (ctx) => {
        const [id] = ctx.args as [string];
        if (!ctx.changes.some((c) => c.store === "chatRail")) return null;
        return railMembers(ctx.after, id)
          .filter((m) => !railMembers(ctx.before, id).includes(m))
          .map((m) => call("removeChatChannelMember", id, m));
      },
    },
  },
  // Leaving a channel yourself retires the room locally and on the server;
  // nothing re-admits you, so it is not recorded.
  removeChatChannelMember: {
    spec: {
      label: (ctx) => {
        const [id, user] = ctx.args as [string, string];
        if (String(ctx.before?.currentUser?._id ?? "") === user) return null;
        return `Removed ${personName(ctx.before, user)} from ${channelName(ctx.before, id)}`;
      },
      inverse: (ctx) => {
        const [id, user] = ctx.args as [string, string];
        return ctx.changes.some((c) => c.store === "chatRail") ? [call("addChatChannelMembers", id, [user])] : null;
      },
    },
  },
  dispatchChatEdit: {
    spec: {
      label: (ctx) => {
        const channel = ctx.before?.chatMessages?.[ctx.args[0] as string]?.channel_id;
        return channel ? `Edited a message in ${channelName(ctx.before, String(channel))}` : "Edited a message";
      },
      inverse: (ctx) =>
        cellsOf(ctx, "chatMessages", "content").map((c) => call("dispatchChatEdit", c.id, typeof c.before === "string" ? c.before : "")),
    },
  },

  // ── Team settings and membership ───────────────────────────────────────────
  // The draft restores the captured teams / teamMembers cells; the inverse
  // sends the value the row held before through the same verb.
  renameTeam: {
    spec: {
      label: (ctx) => `Renamed the team to ${quoted(ctx.args[1] as string, "a new name")}`,
      inverse: (ctx) => {
        const before = teamRow(ctx.before, ctx.args[0] as string);
        return before?.name ? [call("renameTeam", ctx.args[0], before.name)] : null;
      },
    },
  },
  updateTeamIcon: {
    spec: {
      label: () => "Changed the team's icon",
      inverse: (ctx) => {
        const before = teamRow(ctx.before, ctx.args[0] as string);
        return before ? [call("updateTeamIcon", ctx.args[0], { icon: before.icon, icon_color: before.icon_color })] : null;
      },
    },
  },
  updateTeamTaskStatuses: {
    spec: {
      label: () => "Edited the team's task statuses",
      inverse: (ctx) => {
        const before = teamRow(ctx.before, ctx.args[0] as string);
        return before ? [call("updateTeamTaskStatuses", ctx.args[0], teamTaskStatuses(before.task_statuses))] : null;
      },
    },
  },
  setTeamMemberRole: {
    spec: {
      label: (ctx) => `Made ${personName(ctx.before, ctx.args[1] as string)} ${ctx.args[2] === "admin" ? "an admin" : "a member"}`,
      inverse: (ctx) => {
        const before = (ctx.before?.teamMembers ?? []).find((m: any) => String(m?._id) === ctx.args[1])?.role;
        return before === "admin" || before === "member" ? [call("setTeamMemberRole", ctx.args[0], ctx.args[1], before)] : null;
      },
    },
  },
  removeTeamMember: { never: "sharing: removing a member ends their membership; they come back through an invite" },

  // ── Org record (display-only history items) ────────────────────────────────
  reparentOrgSession: org(reparentSessionLabel),
  reparentOrgRole: org((ctx) => `Moved ${roleName(ctx.before, ctx.args[0] as string)} in the org`),
  createOrgRole: org((ctx) => `Created the role ${quoted((ctx.args[0] as { name?: string })?.name, "role")}`),
  updateOrgRole: org((ctx) => `Edited ${roleName(ctx.before, ctx.args[0] as string)}`),
  setRoleLine: org((ctx) => `Changed the line of ${roleName(ctx.before, ctx.args[0] as string)}`),
  // A project's customized line (writer: workflows). The fork mints the row,
  // a create, so it is not recorded; each later save undoes to the prior graph.
  saveLineWorkflow: viaWriter((ctx) => {
    const wf = ctx.args[0] as { slug?: string; name?: string } | undefined;
    const before = Object.values((ctx.before?.workflows ?? {}) as Record<string, any>).some((w) => w?.slug === wf?.slug);
    return before ? `Edited the stations of ${quoted(wf?.name, "the line")}` : null;
  }),
  followOrgChannel: org((ctx) => `${ctx.args[2] ? "Followed" : "Unfollowed"} a channel for a role`),
  staffHeadOfPeople: org(() => "Staffed the Head of People"),
  hireExecutiveAssistant: org(() => "Hired an executive assistant"),
  acceptAllOrgProposal: org(() => "Accepted an org proposal"),
  decideOrgProposalAsk: org((ctx) => `${ctx.args[2] === "accept" ? "Accepted" : "Skipped"} an org proposal ask`),
  decideOrgProposalChange: org((ctx) => `${ctx.args[1] === "accept" ? "Accepted" : "Skipped"} an org change`),
  withdrawOrgProposal: org(() => "Withdrew an org proposal"),
  undoOrgChange: org(() => "Undid an org change"),
  redoOrgChange: org(() => "Redid an org change"),
  retireOrgRole: org((ctx) => `Retired ${roleName(ctx.before, ctx.args[0] as string)}`),
  splitOrgRole: org((ctx) => `Split ${roleName(ctx.before, (ctx.args[0] as { role_id: string }).role_id)} into two leads`),
  settleOrgHandoff: org((ctx) => `${ctx.args[1] === "close" ? "Closed" : "Ran"} the handoff of ${roleName(ctx.before, ctx.args[0] as string)}`),
  setOrgLineMerge: org((ctx) => `Turned the merge step ${ctx.args[1] ? "on" : "off"} for ${roleName(ctx.before, ctx.args[0] as string)}`),
  markOrgTemplateSetup: org((ctx) => `Marked a setup item ${String(ctx.args[2])}`),
  activateOrgTemplateRoutine: org(() => "Turned on a template role's routine"),
  setOrgTemplateLearning: org((ctx) => `${ctx.args[1] ? "Let" : "Stopped"} Codecast learn${ctx.args[1] ? "" : "ing"} from template roles`),
  // Not in the record: a reset wipes the chart the record describes, and
  // bringing a seat online or running the host step acts on a machine.
  resetOrg: { never: "machine control: a reset retires every role and its standing agents, which an undo cannot rewind" },
  provisionOrgRole: { never: "machine control: it starts the role's standing agent on a host" },
  requestOrgTemplateBind: { never: "machine control: the host's daemon runs the bind on a machine" },
  sayOnOrgProposal: { never: "send: a reply in a proposal thread has reached the people and roles in it" },
};
