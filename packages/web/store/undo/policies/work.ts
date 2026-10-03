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
import { DEFAULT_TASK_STATUS_NAMES } from "@codecast/shared/tasks";
import { assigneeLabelOf, resolveAssigneeInfo } from "../../../lib/liveEntities";
import type { UndoPolicy } from "../policy";
import { counted, quoted, sessionTitle } from "../labels";
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

const statusName = (status: unknown) =>
  DEFAULT_TASK_STATUS_NAMES[status as keyof typeof DEFAULT_TASK_STATUS_NAMES] ?? String(status);

function assigneeName(state: any, assignee: string): string {
  const info = resolveAssigneeInfo(assignee, null, state?.teamMembers, state?.currentUser, state?.orgTree?.roles);
  return assigneeLabelOf(assignee, info);
}

/** "Moved ct-123 to Done", "Assigned ct-123 to Sam", and "and N subtasks" for a cascade. */
function taskLabel(ctx: UndoCtx, shortId: string, fields: Record<string, unknown>): string {
  const own = new Set(Object.values(ctx.before?.tasks ?? {}).filter((t: any) => t?.short_id === shortId).map((t: any) => String(t._id)));
  const subtasks = rowIds(cellsOf(ctx, "tasks")).filter((id) => !own.has(id)).length;
  const who = subtasks > 0 ? `${shortId} and ${counted(subtasks, "subtask")}` : shortId;
  if (fields.status !== undefined) return `Moved ${who} to ${statusName(fields.status)}`;
  // A refinement rides along with its category; any other pair is an edit.
  if (Object.keys(fields).filter((k) => k !== "subtask_resolution" && k !== "status_id").length > 1) return `Edited ${shortId}`;
  if (fields.assignee !== undefined) {
    return fields.assignee ? `Assigned ${shortId} to ${assigneeName(ctx.after, String(fields.assignee))}` : `Unassigned ${shortId}`;
  }
  if (fields.parent !== undefined) return fields.parent ? `Moved ${shortId} under ${fields.parent}` : `Moved ${shortId} to the top level`;
  if (fields.title !== undefined) return `Renamed ${shortId}`;
  if (fields.priority !== undefined) return `Set ${shortId} to ${fields.priority} priority`;
  if (fields.labels !== undefined) return `Changed the labels of ${shortId}`;
  if (fields.sort_order !== undefined) return `Reordered ${shortId}`;
  return `Edited ${shortId}`;
}

// closed_at and the attempt stamps are the server's to set: a reopen leaves
// the server's closed_at in place, so restoring the cached one locally would
// hold a lock its echo never matches.
const TASK_SERVER_STAMPS = ["closed_at", "attempt_count", "last_attempted_at"] as const;

// ── Plans, projects, initiatives, docs ───────────────────────────────────────

function editLabel(row: any, fields: Record<string, unknown>, noun: string): string {
  const name = quoted(row?.title, noun);
  if (fields.title !== undefined && fields.title !== row?.title) return `Renamed ${name} to ${quoted(String(fields.title), noun)}`;
  if (fields.status !== undefined) return `Marked ${name} ${String(fields.status).replace(/_/g, " ")}`;
  return `Edited ${name}`;
}

const planOf = (state: any, ref: string) =>
  Object.values(state?.plans ?? {}).find((p: any) => p?.short_id === ref || p?._id === ref) as any;
const projectOf = (state: any, id: string) => state?.projects?.[id] ?? Object.values(state?.projects ?? {}).find((p: any) => p?._id === id);
const docTitle = (state: any, id: string) => quoted(state?.docs?.[id]?.title ?? state?.docDetails?.[id]?.title, "doc");

// ── Conversations: privacy and project ───────────────────────────────────────

const CONV_STORES = ["conversations", "sessions"] as const;

/** A conversation field's prior value, from the cells that changed it (either store copy). */
function priorOf(ctx: UndoCtx, id: string, field: string): unknown {
  const cells = ctx.changes.filter((c) => c.id === id && c.field === field && (CONV_STORES as readonly string[]).includes(c.store));
  const known = cells.find((c) => c.before !== undefined) ?? cells[0];
  return known ? known.before : ctx.before?.conversations?.[id]?.[field];
}

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

// setPrivacy(true) stores team_visibility "private" even on a row born
// private with none, so an undo back to private writes that spelling and its
// lock retires on the echo.
const spellPrivacy = (cells: CellChange[]): CellChange[] =>
  cells.map((c) =>
    c.field === "team_visibility" && c.before == null && priorPrivate(cells, c.id)
      ? { ...c, before: "private", hadBefore: true }
      : c,
  );

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

// ── Org ──────────────────────────────────────────────────────────────────────

const roleName = (state: any, id: string) =>
  quoted(((state?.orgTree?.roles ?? []) as any[]).find((r) => String(r?._id) === id)?.name, "role");
const org = (label: (ctx: UndoCtx) => string): Spec => ({ spec: { label, external: "org" } });

export const WORK_UNDO_POLICY: UndoPolicy = {
  // ── Tasks (writer: updateTask per row) ─────────────────────────────────────
  updateTask: viaWriter((ctx) => taskLabel(ctx, ctx.args[0] as string, (ctx.args[1] ?? {}) as Record<string, unknown>), {
    ignoreFields: TASK_SERVER_STAMPS,
  }),
  updateTaskStatus: viaWriter((ctx) => taskLabel(ctx, ctx.args[0] as string, { status: ctx.args[1] }), {
    ignoreFields: TASK_SERVER_STAMPS,
  }),

  // ── Plans, projects, initiatives (writers: their update verbs) ─────────────
  updatePlan: viaWriter((ctx) => editLabel(planOf(ctx.before, ctx.args[0] as string), ctx.args[1] as Record<string, unknown>, "plan")),
  updateProject: viaWriter((ctx) => editLabel(projectOf(ctx.before, ctx.args[0] as string), ctx.args[1] as Record<string, unknown>, "project")),
  updateInitiative: viaWriter((ctx) =>
    editLabel(ctx.before?.initiatives?.[ctx.args[0] as string], (ctx.args[1] ?? {}) as Record<string, unknown>, "initiative"),
  ),
  addInitiativeProject: viaWriter(
    (ctx) => `Added ${quoted(projectOf(ctx.before, ctx.args[1] as string)?.title, "project")} to ${quoted(ctx.before?.initiatives?.[ctx.args[0] as string]?.title, "initiative")}`,
  ),
  removeInitiativeProject: viaWriter(
    (ctx) => `Removed ${quoted(projectOf(ctx.before, ctx.args[1] as string)?.title, "project")} from ${quoted(ctx.before?.initiatives?.[ctx.args[0] as string]?.title, "initiative")}`,
  ),
  setInitiativeProjects: viaWriter((ctx) => `Reordered the projects of ${quoted(ctx.before?.initiatives?.[ctx.args[0] as string]?.title, "initiative")}`),
  // Naming a lead also widens the role's scope in the org record, in one
  // server transaction (orgRoles.setProjectLead); the org record owns its undo.
  setProjectLead: org((ctx) =>
    ctx.args[1]
      ? `Made ${roleName(ctx.before, ctx.args[1] as string)} lead of ${quoted(projectOf(ctx.before, ctx.args[0] as string)?.title, "project")}`
      : `Cleared the lead of ${quoted(projectOf(ctx.before, ctx.args[0] as string)?.title, "project")}`,
  ),

  // ── Docs (writer: updateDoc, pinDoc, moveDoc, restoreArchivedDoc) ──────────
  // The editor owns text undo; a content-only save records nothing.
  updateDoc: viaWriter(
    (ctx) => {
      if (!ctx.changes.some((c) => c.store === "docs" && c.field !== "updated_at")) return null;
      const fields = (ctx.args[1] ?? {}) as Record<string, unknown>;
      const title = docTitle(ctx.before, ctx.args[0] as string);
      return fields.title !== undefined && fields.title !== ctx.before?.docs?.[ctx.args[0] as string]?.title
        ? `Renamed ${title} to ${quoted(String(fields.title), "doc")}`
        : `Edited ${title}`;
    },
    { ignoreFields: ["content", "overflow"] },
  ),
  pinDoc: viaWriter((ctx) => `${ctx.args[1] ? "Starred" : "Unstarred"} ${docTitle(ctx.before, ctx.args[0] as string)}`),
  moveDoc: viaWriter((ctx) => `Moved ${docTitle(ctx.before, ctx.args[0] as string)}`),
  archiveDoc: viaWriter((ctx) => `Archived ${docTitle(ctx.before, ctx.args[0] as string)}`, { toast: true }),

  // ── Inbox filing and project ───────────────────────────────────────────────
  assignSessionToBucket: viaWriter((ctx) => {
    const [conv, bucket] = ctx.args as [string, string | null];
    return bucket
      ? `Labeled ${sessionTitle(ctx.before, conv)} ${quoted(ctx.before?.buckets?.[bucket]?.name, "label")}`
      : `Removed the label from ${sessionTitle(ctx.before, conv)}`;
  }),
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
    },
  },

  // ── Privacy (immutable on the patch rail, so an inverse) ───────────────────
  // An undo that would widen who sees the session is offered only from the
  // toast and the timeline; blind ⌘Z stops at it. One that narrows (taking
  // back an accidental share) is an ordinary undo.
  setPrivacy: {
    spec: {
      label: (ctx) => `${ctx.args[1] ? "Made" : "Shared"} ${sessionTitle(ctx.before, ctx.args[0] as string)}${ctx.args[1] ? " private" : " with the team"}`,
      inverse: restorePrivacy,
      spell: spellPrivacy,
      confirm: undoWidens,
      toast: true,
    },
  },
  setTeamVisibility: {
    spec: {
      label: (ctx) => `Set ${sessionTitle(ctx.before, ctx.args[0] as string)} to ${visibilityName(ctx.args[1])} team visibility`,
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
  // the inverse sends the prior fields. A field the view did not have before
  // cannot be unset by savedViews.webUpdate and is left to the next push.
  updateSavedView: {
    spec: {
      label: (ctx) => `Edited view ${quoted(ctx.before?.savedViews?.[ctx.args[0] as string]?.name, "view")}`,
      inverse: (ctx) =>
        rowIds(cellsOf(ctx, "savedViews")).flatMap((id) => {
          const fields: Record<string, unknown> = {};
          for (const c of cellsOf(ctx, "savedViews")) {
            if (c.id === id && c.field && c.field !== "updated_at" && c.before !== undefined) fields[c.field] = c.before;
          }
          return Object.keys(fields).length ? [call("updateSavedView", id, fields)] : [];
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

  // ── Org record (display-only history items) ────────────────────────────────
  reparentOrgSession: org((ctx) => `Moved ${sessionTitle(ctx.before, ctx.args[0] as string)} in the org`),
  reparentOrgRole: org((ctx) => `Moved ${roleName(ctx.before, ctx.args[0] as string)} in the org`),
  createOrgRole: org((ctx) => `Created the role ${quoted((ctx.args[0] as { name?: string })?.name, "role")}`),
  updateOrgRole: org((ctx) => `Edited ${roleName(ctx.before, ctx.args[0] as string)}`),
  setRoleLine: org((ctx) => `Changed the line of ${roleName(ctx.before, ctx.args[0] as string)}`),
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
  sayOnOrgProposal: { never: "send: a reply in a proposal thread has reached the people and roles in it" },
};
