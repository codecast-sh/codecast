import type { useTrackedStore } from "../../store/inboxStore";

type TrackedDeps = Parameters<typeof useTrackedStore>[0];

/** The asking session's fields that AskingSessionView draws, as tracked-store
 *  deps: its name, project, liveness and identity (so the face re-renders when
 *  someone changes the character). One list for every container that feeds
 *  the view. */
export function askingSessionDeps(conversationId: string): TrackedDeps {
  return [
    (st) => st.sessions[conversationId]?.title,
    (st) => st.sessions[conversationId]?.project_path,
    (st) => st.sessions[conversationId]?.status,
    (st) => st.sessions[conversationId]?.character_avatar,
    (st) => st.sessions[conversationId]?.standing_role_id,
  ];
}
