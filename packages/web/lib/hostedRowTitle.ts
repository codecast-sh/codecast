// What a hosted inbox row is called, read off the store: hostedTitle over the
// conversation row, the session row, and the first ask in the transcript (or
// the send still on its way). The web rail and the phone inbox, and their
// same-name suffixes, all read it, so a conversation has one name everywhere.
import type { useInboxStore } from "../store/inboxStore";
import { hostedTitle } from "./conversationTitle";
import { firstUserPromptOf } from "../hooks/useForkTree";

export type TitleState = Pick<ReturnType<typeof useInboxStore.getState>, "conversations" | "sessions" | "messages" | "pendingMessages">;

export function hostedRowTitle(s: TitleState, id: string): string {
  return hostedTitle(s.conversations[id] as any, s.sessions[id] as any, () =>
    firstUserPromptOf([...(s.messages[id] ?? []), ...(s.pendingMessages[id] ?? [])]));
}
