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
// applyHideTransition), a field the kill's draft never wrote, so the captured
// cells cannot restore it, and shouldShowInInbox hides a row on it alone. The
// spell adds a clear of it on each store copy of a row the kill retired that
// was not killed before (either twin names the row: a child a parent's kill
// cascades over usually has no conversations row). The clear rides the first
// restoreSession pass beside the row's inbox_dismissed_at clear, the un-kill
// shape the dispatch guard honours (dispatch.ts), so the server acknowledges it
// and the acknowledgement retires both copies' locks whatever reaches the
// server next (a redo, a fresh kill). A clear sent on its own is stripped by
// that guard, and its locks could only retire on a null echo a re-kill never
// sends. The sessions row does not dispatch the marker, so the conversations
// copy carries it even on a thin meta row that never held the stamp.
function spellUnkill(cells: CellChange[], ctx?: UndoCtx): CellChange[] {
  const out = [...cells];
  for (const c of cells) {
    if (!isSessionCell(c) || c.field !== "inbox_dismissed_at" || c.before || !c.after) continue;
    if (ctx?.before?.conversations?.[c.id]?.inbox_killed_at || ctx?.before?.sessions?.[c.id]?.inbox_killed_at) continue;
    if (out.some((k) => k.store === c.store && k.id === c.id && k.field === "inbox_killed_at")) continue;
    out.push({ ...c, field: "inbox_killed_at", before: null, hadBefore: true, after: undefined, hadAfter: false });
  }
  return out;
}

const HIDE: Partial<UndoSpec> = { inverse: restoreEachHidden, restoreView: true, toast: true };
const KILL: Partial<UndoSpec> = { ...HIDE, spell: spellUnkill };
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

// A toggle only writes false over a favorite, and a row can be one by the
// favorites list alone, with no flag of its own. Its cell then has no prior
// value, and restoring that would send the server a clear, leaving the row
// unfavorited. The value it stood for is true.
const spellUnfavorite = (cells: CellChange[]): CellChange[] =>
  cells.map((c) =>
    isSessionCell(c) && c.field === "is_favorite" && c.after === false && c.before == null ? { ...c, before: true, hadBefore: true } : c,
  );

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
  toggleFavorite: onSession((ctx) => (ctx.after?.conversations?.[ctx.args[0] as string]?.is_favorite ? "Favorited" : "Unfavorited"), {
    spell: spellUnfavorite,
  }),
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
