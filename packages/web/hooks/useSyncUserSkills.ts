// The skills catalog the slash menus read: store.userSkills, fed from
// users.getMySkills. It is large (hundreds of KB for a heavy user) and changes
// only when a daemon reports new skills, so it rides its own query rather than
// the user row, whose daemon stamps change every few seconds.
//
// Web mounts the live feeder where a slash menu mounts (the conversation
// composer, the compose popup); Convex re-sends it only when it changes. The
// phone reads it once per signed-in launch (useFetchUserSkillsOnce) and keeps
// it on disk between launches, so a reconnect never downloads it again.
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { applyCollectionFeed, useSyncCollection } from "./useSyncCollection";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useWatchEffect } from "./useWatchEffect";

/** The query's answer as the store's scalar: null (signed out) syncs nothing. */
export const skillsOf = (data: { skills: string | null } | null | undefined) =>
  data ? (data.skills ?? "") : data;

/** Feeder: the live skills catalog. */
export function useSyncUserSkills(enabled = true) {
  return useSyncCollection("userSkills", api.users.getMySkills, enabled ? {} : "skip", { select: skillsOf });
}

// The user whose catalog this launch already read.
let fetchedFor: string | null = null;

/** Feeder: one read of the skills catalog per signed-in user per launch. */
export function useFetchUserSkillsOnce() {
  const convex = useConvex();
  const authSettled = useServerAuthSettled();
  const userId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  useWatchEffect(() => {
    if (!authSettled || !userId || fetchedFor === userId) return;
    fetchedFor = userId;
    convex.query(api.users.getMySkills, {}).then(
      (data) => applyCollectionFeed("userSkills", data, skillsOf),
      () => {
        if (fetchedFor === userId) fetchedFor = null;
      },
    );
  }, [authSettled, userId, convex]);
}

/** Reader: the skills catalog JSON, or undefined before it is known. */
export function useUserSkills(): string | undefined {
  return useInboxStore((s) => s.userSkills);
}
