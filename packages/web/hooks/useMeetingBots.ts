// The meeting bots the viewer sent (convex meetingBots.listMine), store-fed:
// the feeder files every answer in `meetingBots`, and the calls page's
// meeting link field reads the store. Per view, so it never gates on the
// sync host: it mounts only while the calls page shows the field.
import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useCoarseNow } from "./useCoarseNow";
import { MEETING_BOT_FINAL, type MeetingBot } from "../store/meetingBotsSlice";

/** How long a bot that ended, failed or was removed stays listed, so a refusal is seen. */
const FINAL_SHOWN_MS = 60 * 60_000;

const botSig = (b: MeetingBot) => `${b.status}|${b.status_words ?? ""}|${b.transcript_id ?? ""}|${b.platform_name}|${b.meet_id}|${b.join_at ?? ""}`;
const newestFirst = (a: MeetingBot, b: MeetingBot) => b.created_at - a.created_at;

/** Feeds the store and returns the bots still going, plus the ones that
 *  stopped in the last hour, newest first. */
export function useMeetingBots(): MeetingBot[] {
  useSyncCollection("meetingBots", api.meetingBots.listMine, {});
  const now = useCoarseNow(60_000);
  const where = useCallback(
    (b: MeetingBot) => !MEETING_BOT_FINAL.has(b.status) || now - b.updated_at < FINAL_SHOWN_MS,
    [now],
  );
  return useCollectionRows<MeetingBot>("meetingBots", { where, sig: botSig, sort: newestFirst });
}
