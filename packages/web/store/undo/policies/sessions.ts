// Undo policy for sessions, the inbox, buckets, favorites and decisions.
//
// Most of these ride the patch rail: the engine captures every cell the action
// wrote (the snooze a triage verb clears, title_is_custom, the favorites
// mirror) and one applyUndoPatches pass carries the prior values back. The
// hides are the exception: a teammate's row is hidden through inbox_hides,
// which a patch cannot reach, so their undo names restoreSession per row.
// Labels read the state before the action, so they name what the user saw.
import type { CellChange, Invocation, UndoCtx, UndoSpec } from "@platform/engine";
import type { UserRest } from "@codecast/shared/contracts";
import type { UndoPolicy } from "../policy";
import { counted, quoted, sessionTitle } from "../labels";

export const USER_REST_LABEL: Record<UserRest, string> = {
  needs_input: "Needs input",
  done: "Done",
  dormant: "Dormant",
};

/** A spec whose label is "<verb> “<title of args[0]>”". */
const onSession = (verb: string | ((ctx: UndoCtx) => string), extra?: Partial<UndoSpec>): { spec: UndoSpec } => ({
  spec: {
    label: (ctx) => `${typeof verb === "string" ? verb : verb(ctx)} ${sessionTitle(ctx.before, ctx.args[0] as string)}`,
    ...extra,
  },
});

const isSessionCell = (c: CellChange) => c.store === "sessions" || c.store === "conversations";

// One restoreSession per row the hide touched, read from the cells so a
// partial undo sends none for a row it skipped. Owners land through the
// patches the first invocation carries; for anyone else the server's
// restoreSession side effect drops their inbox_hides record (it is a no-op for
// the runner and owners, who never get one).
function restoreEachHidden(ctx: UndoCtx): Invocation[] {
  const ids: string[] = [];
  for (const c of ctx.changes) if (isSessionCell(c) && !ids.includes(c.id)) ids.push(c.id);
  return ids.map((id) => ({ action: "restoreSession", args: [id], runDraft: false }));
}

// The server's kill transition also stamps inbox_killed_at (cleanup.ts
// applyHideTransition), a field the kill's draft never wrote, so the patches
// cannot restore it. Once that echo lands shouldShowInInbox hides the row on
// it alone, so an undo would show nothing until the server's un-kill came
// back. A second pass clears it locally on each row the kill retired that was
// not killed before; its lock holds through stale pushes until that un-kill
// echoes. The server ignores the clear itself (the dispatch guard honours only
// an un-kill-shaped patch) and un-kills through the first pass's restore.
// Either twin names the row: a child session a parent's kill cascades over
// usually has no conversations row, and shouldShowInInbox reads sessions.
function restoreEachKilled(ctx: UndoCtx): Invocation[] {
  const unkill: string[] = [];
  for (const c of ctx.changes) {
    if (!isSessionCell(c) || c.field !== "inbox_dismissed_at" || c.before || !c.after) continue;
    if (ctx.before?.conversations?.[c.id]?.inbox_killed_at || ctx.before?.sessions?.[c.id]?.inbox_killed_at) continue;
    if (!unkill.includes(c.id)) unkill.push(c.id);
  }
  return [
    ...restoreEachHidden(ctx),
    ...unkill.map((id) => ({ action: "patchConversation", args: [id, { inbox_killed_at: null }] })),
  ];
}

const HIDE: Partial<UndoSpec> = { inverse: restoreEachHidden, restoreView: true, toast: true };
const KILL: Partial<UndoSpec> = { ...HIDE, inverse: restoreEachKilled };
const KILL_NOTE = "(agent stays stopped on undo)";

// patchConversation's gesture callers (the /sessions page) write the triage
// stamps directly; name the gesture the fields describe.
function patchVerb(ctx: UndoCtx): string {
  const fields = (ctx.args[1] ?? {}) as Record<string, unknown>;
  if ("inbox_pinned_at" in fields) return fields.inbox_pinned_at ? "Pinned" : "Unpinned";
  if (fields.inbox_dismissed_at) return "Killed";
  if (fields.inbox_stashed_at) return "Stashed";
  if ("inbox_stashed_at" in fields || "inbox_dismissed_at" in fields) return "Restored";
  return "Edited";
}

function bucketLabel(ctx: UndoCtx): string {
  const [id, fields] = ctx.args as [string, Record<string, unknown>];
  const name = ctx.before?.buckets?.[id]?.name as string | undefined;
  const label = quoted(name, "label");
  if (fields.name !== undefined && fields.name !== name) return `Renamed label ${label} to ${quoted(fields.name as string, "label")}`;
  if (fields.archived_at !== undefined) return `${fields.archived_at ? "Deleted" : "Restored"} label ${label}`;
  if (fields.color !== undefined) return `Recolored label ${label}`;
  return `Reordered label ${label}`;
}

const characters = (ctx: UndoCtx) => {
  const entries = (ctx.args[0] ?? []) as Array<{ id: string }>;
  return entries.length === 1
    ? `Changed the character of ${sessionTitle(ctx.before, entries[0]!.id)}`
    : `Changed the characters of ${counted(entries.length, "session")}`;
};

const LIVE_SWITCH = { never: "the switch is applied to the live agent or daemon, which a field restore cannot reverse" } as const;

export const SESSIONS_UNDO_POLICY: UndoPolicy = {
  deferSession: onSession("Deferred"),
  setSessionRest: {
    spec: {
      label: (ctx) => `Filed ${sessionTitle(ctx.before, ctx.args[0] as string)} as ${USER_REST_LABEL[ctx.args[1] as UserRest] ?? ctx.args[1]}`,
      toast: true,
    },
  },
  pinSession: onSession((ctx) => (ctx.before?.sessions?.[ctx.args[0] as string]?.is_pinned ? "Unpinned" : "Pinned")),
  snoozeSession: onSession("Snoozed"),
  wakeSnoozedSession: onSession("Woke"),
  renameSession: {
    spec: {
      label: (ctx) => `Renamed ${sessionTitle(ctx.before, ctx.args[0] as string)} to ${quoted(ctx.args[1] as string, "untitled")}`,
    },
  },
  setSessionCharacter: onSession("Changed the character of"),
  setSessionCharacters: { spec: { label: characters } },
  patchConversation: onSession(patchVerb),
  toggleFavorite: onSession((ctx) => (ctx.after?.conversations?.[ctx.args[0] as string]?.is_favorite ? "Favorited" : "Unfavorited")),
  // The real switch is applied to the live agent or its daemon (a /model
  // message, switchSessionAgent, reconfigureSession), and agent_type is not
  // editable on the server's patch rail at all, so a field restore would leave
  // the row disagreeing with the running session.
  updateSessionProject: LIVE_SWITCH,
  setConversationModel: LIVE_SWITCH,
  setConversationAgent: LIVE_SWITCH,
  setConversationAgentDefinition: LIVE_SWITCH,
  restoreSession: onSession("Restored"),
  updateBucket: { spec: { label: bucketLabel } },
  stashSession: onSession((ctx) => ((ctx.args[1] as { hidden?: boolean } | undefined)?.hidden ? "Stashed and hid" : "Stashed"), HIDE),
  killSession: {
    spec: {
      label: (ctx) => `Killed ${sessionTitle(ctx.before, ctx.args[0] as string)} ${KILL_NOTE}`,
      ...KILL,
    },
  },
  killSessions: {
    spec: {
      label: (ctx) => {
        const ids = (ctx.args[0] ?? []) as string[];
        return ids.length === 1
          ? `Killed ${sessionTitle(ctx.before, ids[0]!)} ${KILL_NOTE}`
          : `Killed ${counted(ids.length, "session")} (agents stay stopped on undo)`;
      },
      ...KILL,
    },
  },
  // assignSessionToBucket and switchProject are classified in work.ts, beside
  // the bucketAssignments writer and the other conversation inverses.
  reopenDecision: {
    never: "Reopening hands a role's answer back to the person; the role's answer cannot be re-given from a patch, and the decision stays answerable",
  },
};
