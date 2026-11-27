// A milestone's Start opens the composer with the priority and milestone the
// create links the session to (dispatch createSession, which puts the session
// in the priority's workspace). The server can still refuse the link (the
// person picked Hidden, the folder is locked private, the priority went
// away); then the person is told so, instead of finding the session unlinked.
// Both apps: web says it in a toast, the phone in an alert (`say`).
import { useInboxStore } from "../store/inboxStore";
import type { SessionStart } from "../store/composeSlice";
import { lookup } from "./liveEntities";

/** How long after the create a refusal is still told: the server's row lands well within it. */
const WATCH_MS = 60_000;

/**
 * What the server's row says of a Start's link: null while only the local
 * stub is known (its `priority_id` is unset; the server always sends one,
 * null when unlinked), "linked", or the sentence telling the person why not.
 * A folder the person mapped to a team keeps its sessions there, and a Start
 * never shares a private one, so those are the usual reasons.
 */
export function startLinkVerdict(
  row: { priority_id?: string | null; is_private?: boolean; team_id?: string | null } | undefined,
  start: SessionStart,
  priorityWorkspace: string | undefined,
  teamName: (teamId: string) => string | undefined = () => undefined,
): null | "linked" | string {
  if (!row || row.priority_id === undefined) return null;
  if (row.priority_id) return "linked";
  const what = start.priority ?? "the priority";
  if (row.team_id && priorityWorkspace !== `team:${row.team_id}`) return `This folder belongs to ${teamName(String(row.team_id)) ?? "another team"}, so the session isn't on ${what}`;
  if (row.is_private && priorityWorkspace?.startsWith("team:")) return `This session is private, so it isn't on ${what}: share it with the team to link it`;
  return `This session isn't on ${what}: that milestone can't take it`;
}

/** Passes `created` through; once it resolves, says (`say`) if the server's row came back without the Start's link. */
export function sayIfStartUnlinked<T>(created: Promise<T>, start: SessionStart | null | undefined, say: (message: string) => void): Promise<T> {
  if (!start?.priority) return created;
  created.then((id) => {
    if (typeof id !== "string") return;
    const settle = (s: ReturnType<typeof useInboxStore.getState>): boolean => {
      const row = (s.sessions as Record<string, any>)[id];
      const workspace = (lookup(s.priorities, start.priority!) as { workspace?: string } | undefined)?.workspace;
      const teamName = (teamId: string) => (s.teams ?? []).find((t: any) => String(t._id) === teamId)?.name as string | undefined;
      const verdict = startLinkVerdict(row, start, workspace, teamName);
      if (verdict && verdict !== "linked") say(verdict);
      return verdict != null;
    };
    if (settle(useInboxStore.getState())) return;
    const stop = useInboxStore.subscribe((s) => { if (settle(s)) { stop(); clearTimeout(timer); } });
    const timer = setTimeout(stop, WATCH_MS);
  }, () => {});
  return created;
}
