// Meeting bots (convex/meetingBots.ts): a Recall.ai bot sent to a meeting
// link the person pasted on the calls page. The rows live in `meetingBots`
// (clientSyncRegistry, fed by meetingBots.listMine); these are its writes,
// each painted on the press and riding `dispatch` to the side effect of the
// same name.
//
// - sendMeetingBot paints a stub keyed by a client key; the server row
//   carries that key back (altKey) and the stub folds into it. A link the
//   server refuses rejects the caller with its words, and the caller takes
//   the stub back with discardMeetingBotStub.
// - cancelMeetingBot marks the bot cancelled on the draft; the server row
//   echoes the same status.
import { asyncAction, action, sync } from "./mutativeMiddleware";

export type MeetingBotStatus =
  | "requested" | "scheduled" | "joining" | "waiting_room" | "in_call" | "recording" | "ended" | "failed" | "cancelled";

/** One row as meetingBots.listMine shapes it (convex meetingBots shapeBot). */
export type MeetingBot = {
  _id: string;
  client_key: string | null;
  meet_id: string;
  room_key: string;
  meeting_url: string;
  platform: string;
  platform_name: string;
  status: MeetingBotStatus;
  status_words: string | null;
  join_at: number | null;
  transcript_id: string | null;
  created_at: number;
  updated_at: number;
};

export const MEETING_BOT_FINAL: ReadonlySet<MeetingBotStatus> = new Set(["ended", "failed", "cancelled"]);

export const meetingBotStubId = (clientKey: string) => `temp_bot_${clientKey}`;

/** One upcoming meeting with a link on the viewer's calendar
 *  (convex meetingCalendar.listUpcoming). */
export type CalendarMeeting = {
  _id: string;
  event_id: string;
  title: string;
  starts_at: number;
  ends_at: number;
  meeting_url: string;
  platform: string;
  /** The viewer's own switch; null follows join-all. */
  choice: "on" | "off" | null;
  meet_id: string | null;
  updated_at: number;
};

/** The viewer's meeting bot settings, one row (meetingCalendar.getSettings). */
export type MeetingBotSettings = {
  _id: string;
  calendar: "connected" | "missing_scope" | "not_connected";
  join_all: boolean;
};

export const MEETING_BOT_SETTINGS_ID = "meetingBotSettings";

/** Whether a bot is wanted for a meeting: its own switch, else join-all. */
export const calendarMeetingWanted = (m: Pick<CalendarMeeting, "choice">, joinAll: boolean) =>
  m.choice === "on" || (m.choice !== "off" && joinAll);

export type MeetingBotsSliceActions = {
  setCalendarMeetingChoice: (id: string, choice: "on" | "off" | null) => void;
  setMeetingBotJoinAll: (joinAll: boolean) => void;
  sendMeetingBot: (meetingUrl: string, clientKey: string) => Promise<MeetingBot>;
  cancelMeetingBot: (meetId: string) => void;
  discardMeetingBotStub: (clientKey: string) => void;
};

export function createMeetingBotsSlice(): MeetingBotsSliceActions {
  return {
    // A meeting's switch and join-all paint on the press and ride dispatch
    // to the side effects of the same name (convex dispatch.ts), which bring
    // the viewer's bots in line; the bots themselves arrive through meetingBots.
    setCalendarMeetingChoice: action(function (this: any, id: string, choice: "on" | "off" | null) {
      const row = this.meetingCalendarEvents[id] as CalendarMeeting | undefined;
      if (!row) return;
      row.choice = choice;
    }) as MeetingBotsSliceActions["setCalendarMeetingChoice"],

    setMeetingBotJoinAll: action(function (this: any, joinAll: boolean) {
      const row = this.meetingBotSettings[MEETING_BOT_SETTINGS_ID] as MeetingBotSettings | undefined;
      if (!row) return;
      row.join_all = joinAll;
    }) as MeetingBotsSliceActions["setMeetingBotJoinAll"],

    sendMeetingBot: asyncAction(function (this: any, meetingUrl: string, clientKey: string) {
      const now = Date.now();
      const id = meetingBotStubId(clientKey);
      this.meetingBots[id] = {
        _id: id, client_key: clientKey, meet_id: "", room_key: "", meeting_url: meetingUrl.trim(),
        platform: "", platform_name: "", status: "requested", status_words: null, join_at: null,
        transcript_id: null, created_at: now, updated_at: now,
      } satisfies MeetingBot;
    }) as unknown as MeetingBotsSliceActions["sendMeetingBot"],

    cancelMeetingBot: action(function (this: any, meetId: string) {
      const row = Object.values(this.meetingBots as Record<string, MeetingBot>).find((b) => b.meet_id === meetId);
      if (!row) return;
      row.status = "cancelled";
      row.updated_at = Date.now();
    }) as MeetingBotsSliceActions["cancelMeetingBot"],

    discardMeetingBotStub: sync(function (this: any, clientKey: string) {
      const id = meetingBotStubId(clientKey);
      if (!this.meetingBots[id]) return;
      delete this.meetingBots[id];
      delete this.pending[`meetingBots:${id}`];
    }) as MeetingBotsSliceActions["discardMeetingBotStub"],
  };
}
