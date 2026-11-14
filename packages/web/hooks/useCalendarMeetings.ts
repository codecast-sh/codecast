// The viewer's calendar meetings and meeting bot settings
// (convex meetingCalendar.ts), store-fed like their bots (useMeetingBots):
// the feeders file each answer, the calls page reads the store. Mounted only
// while the calls page shows the calendar list.
import { useCallback, useEffect, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useCoarseNow } from "./useCoarseNow";
import { MEETING_BOT_SETTINGS_ID, type CalendarMeeting, type MeetingBotSettings } from "../store/meetingBotsSlice";

const meetingSig = (m: CalendarMeeting) => `${m.title}|${m.starts_at}|${m.ends_at}|${m.platform}|${m.choice ?? ""}|${m.meet_id ?? ""}`;
const settingsSig = (s: MeetingBotSettings) => `${s.calendar}|${s.join_all}`;
const soonestFirst = (a: CalendarMeeting, b: CalendarMeeting) => a.starts_at - b.starts_at;

export function useMeetingBotSettings(): MeetingBotSettings | null {
  useSyncCollection("meetingBotSettings", api.meetingCalendar.getSettings, {});
  const rows = useCollectionRows<MeetingBotSettings>("meetingBotSettings", { sig: settingsSig });
  return rows.find((r) => r._id === MEETING_BOT_SETTINGS_ID) ?? null;
}

/** Upcoming meetings with links, soonest first, ones that ended dropped.
 *  Reads the calendar once when it mounts with a connected calendar, so a
 *  meeting added a minute ago is there without waiting for the sweep. */
export function useCalendarMeetings(connected: boolean): CalendarMeeting[] {
  useSyncCollection("meetingCalendarEvents", api.meetingCalendar.listUpcoming, {});
  const refresh = useAction(api.meetingCalendar.refreshMine);
  const asked = useRef(false);
  useEffect(() => {
    if (!connected || asked.current) return;
    asked.current = true;
    void refresh({}).catch(() => {});
  }, [connected, refresh]);
  const now = useCoarseNow(60_000);
  const where = useCallback((m: CalendarMeeting) => m.ends_at > now, [now]);
  return useCollectionRows<CalendarMeeting>("meetingCalendarEvents", { where, sig: meetingSig, sort: soonestFirst });
}
