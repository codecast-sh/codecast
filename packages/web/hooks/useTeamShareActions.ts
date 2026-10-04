// The two writes a share control makes for one session, with the one toast
// each earns (gestureToast: the recorded entry's Undo toast when there is one). The session header, the inbox page and the team feed's chip all
// use these, so the wording and the store calls cannot drift apart. Both
// writes are optimistic store actions; the server write rides the dispatch
// side effect (convex/dispatch.ts setPrivacy / setTeamVisibility).
import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { gestureToast } from "../store/undoStack";

export function useTeamShareActions(conversationId: string) {
  const setPrivacy = useInboxStore((s) => s.setPrivacy);
  const setTeamVisibility = useInboxStore((s) => s.setTeamVisibility);
  const setPrivate = useCallback(() => {
    gestureToast("Hidden from the team", () => setPrivacy(conversationId, true));
  }, [conversationId, setPrivacy]);
  const shareWithTeam = useCallback((mode: "summary" | "full") => {
    gestureToast(mode === "full" ? "Sharing full conversation with team" : "Sharing summary with team", () =>
      setTeamVisibility(conversationId, mode));
  }, [conversationId, setTeamVisibility]);
  return { setPrivate, shareWithTeam };
}
