// Chat navigation for the web shell: opening a DM and going to a chat path.
// Kept out of useChatSync so the native bundle can share chat's feeders and
// readers without pulling in Next's router.

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useInboxStore } from "../store/inboxStore";
import { navigateFromHere } from "../lib/desktop";

/** Open (or create) the DM with these teammates and go there. Local-first:
 *  openDmChannel answers in the same tick — an existing room's real id or a
 *  stub the server row supersedes — so the navigation never waits. One hook
 *  for the modal, the rail's suggestions and the sidebar's, so "how a DM
 *  opens" is decided in exactly one place. */
export function useOpenDm(): (memberIds: string[]) => void {
  const openChat = useOpenChatPath();
  return useCallback(
    (memberIds: string[]) => {
      const channelId = useInboxStore.getState().openDmChannel(memberIds);
      openChat(`/chat/${channelId}`);
    },
    [openChat],
  );
}

/** Go to a chat path from wherever the gesture happened. From a satellite
 *  window (the voice window's strip, the people window) the path goes to the
 *  main window and the satellite stays as it was; anywhere else this window
 *  moves. One hook, so the DM opener and the strip's Chat button agree. */
export function useOpenChatPath(): (path: string) => void {
  const router = useRouter();
  return useCallback((path: string) => navigateFromHere(path, (p) => router.push(p)), [router]);
}
