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

const HIDE: Partial<UndoSpec> = { inverse: restoreEachHidden, restoreView: true, toast: true };
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

const basename = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

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
  updateSessionProject: {
    spec: {
      label: (ctx) => `Moved ${sessionTitle(ctx.before, ctx.args[0] as string)} to ${basename(String(ctx.args[1] ?? ""))}`,
    },
  },
  setConversationModel: onSession("Changed the model of"),
  setConversationAgent: {
    spec: {
      label: (ctx) => `Switched ${sessionTitle(ctx.before, ctx.args[0] as string)} to ${ctx.args[1]}`,
    },
  },
  setConversationAgentDefinition: onSession("Changed the agent of"),
  restoreSession: onSession("Restored"),
  updateBucket: { spec: { label: bucketLabel } },
  stashSession: onSession((ctx) => ((ctx.args[1] as { hidden?: boolean } | undefined)?.hidden ? "Stashed and hid" : "Stashed"), HIDE),
  killSession: {
    spec: {
      label: (ctx) => `Killed ${sessionTitle(ctx.before, ctx.args[0] as string)} ${KILL_NOTE}`,
      ...HIDE,
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
      ...HIDE,
    },
  },
  // assignSessionToBucket and switchProject are classified in work.ts, beside
  // the bucketAssignments writer and the other conversation inverses.
  reopenDecision: {
    never: "Reopening hands a role's answer back to the person; the role's answer cannot be re-given from a patch, and the decision stays answerable",
  },
};
