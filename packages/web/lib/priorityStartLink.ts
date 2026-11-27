// A milestone's Start opens the composer with the priority and milestone the
// create links the session to (dispatch createSession, which puts the session
// in the priority's workspace). The server can still refuse the link (the
// person picked Hidden, the folder is locked private, the priority went
// away); then the person is told so, instead of finding the session unlinked.
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import type { SessionStart } from "../store/composeSlice";
import { lookup } from "./liveEntities";

/** How long after the create a refusal is still told: the server's row lands well within it. */
const WATCH_MS = 60_000;

/**
 * What the server's row says of a Start's link: null while only the local
 * stub is known (its `priority_id` is unset; the server always sends one,
 * null when unlinked), "linked", or the sentence telling the person why not.
 */
export function startLinkVerdict(
  row: { priority_id?: string | null; is_private?: boolean } | undefined,
  start: SessionStart,
  priorityWorkspace: string | undefined,
): null | "linked" | string {
  if (!row || row.priority_id === undefined) return null;
  if (row.priority_id) return "linked";
  const what = start.priority ?? "the priority";
  if (row.is_private && priorityWorkspace?.startsWith("team:")) return `This session is private, so it isn't on ${what}: share it with the team to link it`;
  return `This session isn't on ${what}: that milestone can't take it`;
}

/** Passes `created` through; once it resolves, tells the person if the server's row came back without the Start's link. */
export function sayIfStartUnlinked<T>(created: Promise<T>, start: SessionStart | undefined): Promise<T> {
  if (!start?.priority) return created;
  created.then((id) => {
    if (typeof id !== "string") return;
    const settle = (s: ReturnType<typeof useInboxStore.getState>): boolean => {
      const row = (s.sessions as Record<string, any>)[id];
      const workspace = (lookup(s.priorities, start.priority!) as { workspace?: string } | undefined)?.workspace;
      const verdict = startLinkVerdict(row, start, workspace);
      if (verdict && verdict !== "linked") toast(verdict);
      return verdict != null;
    };
    if (settle(useInboxStore.getState())) return;
    const stop = useInboxStore.subscribe((s) => { if (settle(s)) { stop(); clearTimeout(timer); } });
    const timer = setTimeout(stop, WATCH_MS);
  }, () => {});
  return created;
}
