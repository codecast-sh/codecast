import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";

// The person's weekly cards into the store (weeklyCards). A snapshot feed;
// /week mounts it, so nobody without the page open pays for it.
export function useSyncWeeklyCards(opts?: { skip?: boolean }) {
  return useSyncCollection("weeklyCards", api.weeklyCards.listMine, opts?.skip ? "skip" : {});
}
