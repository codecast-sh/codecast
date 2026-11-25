// Moving conversations into a team's workspace, or to Personal (ct-101478):
// the menus and the ⌘K palette share this. Only the person's own sessions
// move (the server's owner check, convex dispatch moveSessionToWorkspace); a
// teammate's in a selection is skipped and the toast counts it.
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { ownsConversationAccount } from "./liveEntities";
import { moveToWorkspaceLedger } from "../components/consequential/ledgers";

/** Where a session sits: the team whose workspace shows it, or null for Personal. */
export function workspaceOf(row: { team_id?: unknown; is_private?: boolean } | undefined): string | null {
  return row && row.is_private === false && row.team_id ? String(row.team_id) : null;
}

/** My sessions among these that are not already in `teamId`, and how many are not mine. */
export function planWorkspaceMove(sessions: Array<{ _id: string }>, teamId: string | null) {
  const s = useInboxStore.getState();
  const rows = sessions.map((row) => ({ ...row, ...(s.conversations[row._id] ?? {}) }) as any);
  const own = rows.filter((r) => ownsConversationAccount(r, s.currentUser?._id));
  return { own, movers: own.filter((r) => workspaceOf(r) !== teamId), skipped: rows.length - own.length };
}

/** The review a move into a team opens: it widens who reads these sessions. */
export function workspaceMoveLedgerFor(sessions: Array<{ _id: string }>, team: { _id: string; name: string }) {
  const { movers } = planWorkspaceMove(sessions, team._id);
  return moveToWorkspaceLedger({ count: movers.length, team: team.name, nowPrivate: movers.filter((r) => workspaceOf(r) === null).length });
}

export function moveSessionsToWorkspace(sessions: Array<{ _id: string }>, teamId: string | null, name: string) {
  const { movers, skipped } = planWorkspaceMove(sessions, teamId);
  const store = useInboxStore.getState();
  for (const r of movers) store.moveSessionToWorkspace(r._id, teamId);
  const notMine = skipped ? ` · skipped ${skipped} not yours` : "";
  if (movers.length) toast.success(`Moved ${movers.length} session${movers.length === 1 ? "" : "s"} to ${name}${notMine}`);
  else toast.error(skipped ? "Only your own sessions move between workspaces" : `Already in ${name}`);
}
