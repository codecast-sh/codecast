// The two writes a share control makes for one session, with the toast each
// one earns. The session header, the inbox page and the team feed's chip all
// use these, so the wording and the store calls cannot drift apart. Both
// writes are optimistic store actions; the server write rides the dispatch
// side effect (convex/dispatch.ts setPrivacy / setTeamVisibility).
import { useCallback } from "react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";

export function useTeamShareActions(conversationId: string) {
  const setPrivacy = useInboxStore((s) => s.setPrivacy);
  const setTeamVisibility = useInboxStore((s) => s.setTeamVisibility);
  const setPrivate = useCallback(() => {
    setPrivacy(conversationId, true);
    toast.success("Hidden from the team", { description: "Only you can open this session now." });
  }, [conversationId, setPrivacy]);
  const shareWithTeam = useCallback((mode: "summary" | "full") => {
    setTeamVisibility(conversationId, mode);
    toast.success(mode === "full" ? "Sharing full conversation with team" : "Sharing summary with team");
  }, [conversationId, setTeamVisibility]);
  return { setPrivate, shareWithTeam };
}
