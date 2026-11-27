// "Open huddles on the board" (lib/calls/huddleSettings), applied once to a
// huddle's stage: when its workspace is known and the person's settings have
// loaded, a stage still on the default view moves to the board. Waiting for
// the settings matters on a cold reload into a live call, where the workspace
// resolves before clientState hydrates.
import { useRef } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";
import { readHuddleSetting } from "../lib/calls/huddleSettings";

export function useBoardViewDefault(workspace: string | null, toBoard: () => void): void {
  const settingsLoaded = useInboxStore((st) => st.clientStateInitialized);
  const decided = useRef(false);
  useWatchEffect(() => {
    if (decided.current || !workspace || !settingsLoaded) return;
    decided.current = true;
    if (readHuddleSetting(useInboxStore.getState().clientState?.ui, "huddleBoardView", workspace)) toBoard();
  }, [workspace, settingsLoaded]);
}
