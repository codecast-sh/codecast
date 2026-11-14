import { CalendarDays } from "lucide-react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Switch } from "../ui/switch";
import { useConnectGesture } from "../../lib/integrations";
import { useInboxStore } from "../../store/inboxStore";
import { useCalendarMeetings, useMeetingBotSettings } from "../../hooks/useCalendarMeetings";
import { useMeetingBots } from "../../hooks/useMeetingBots";
import { calendarMeetingWanted, MEETING_BOT_FINAL, type CalendarMeeting, type MeetingBot } from "../../store/meetingBotsSlice";

// The viewer's upcoming meetings from their Google Calendar, each with a
// switch: on, a bot joins it (scheduled a day ahead, convex
// meetingCalendar.ts). Nothing joins until the person turns a meeting on or
// turns on Join all (decision sd-3233).

const PLATFORM: Record<string, string> = {
  zoom: "Zoom",
  google_meet: "Meet",
  microsoft_teams: "Teams",
  webex: "Webex",
  goto_meeting: "GoTo",
};

const BOT_WORDS: Partial<Record<string, { words: string; tone: string }>> = {
  scheduled: { words: "Scheduled", tone: "text-sol-text-muted" },
  requested: { words: "Scheduled", tone: "text-sol-text-muted" },
  joining: { words: "Joining", tone: "text-sol-cyan" },
  waiting_room: { words: "Waiting room", tone: "text-sol-yellow" },
  in_call: { words: "In the call", tone: "text-sol-cyan" },
  recording: { words: "Recording", tone: "text-sol-green" },
  failed: { words: "Failed", tone: "text-sol-red" },
};

/** "Today 3:00 PM", "Tomorrow 9:30 AM", "Thu 2:00 PM". */
function whenOf(at: number, now = Date.now()): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date(now))) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function MeetingRow({ meeting, joinAll, bot }: { meeting: CalendarMeeting; joinAll: boolean; bot: MeetingBot | null }) {
  const setChoice = useInboxStore((s) => s.setCalendarMeetingChoice);
  const wanted = calendarMeetingWanted(meeting, joinAll);
  const live = bot && !MEETING_BOT_FINAL.has(bot.status) ? BOT_WORDS[bot.status] : null;
  // Back to following join-all when the switch lands on what join-all says.
  const toggle = (on: boolean) => setChoice(meeting._id, on === joinAll ? null : on ? "on" : "off");
  return (
    <li className="flex items-center gap-2 text-meta" data-calendar-meeting={wanted ? "on" : "off"}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sol-text" title={meeting.title}>{meeting.title}</div>
        <div className="flex min-w-0 items-center gap-1.5 text-sol-text-dim">
          <span className="shrink-0 tabular-nums">{whenOf(meeting.starts_at)}</span>
          <span aria-hidden="true">·</span>
          {live ? (
            <span className={`truncate ${live.tone}`}>{live.words}</span>
          ) : (
            <span className="truncate">{PLATFORM[meeting.platform] ?? meeting.platform}</span>
          )}
        </div>
      </div>
      <Switch checked={wanted} onCheckedChange={toggle} aria-label={`Send a bot to ${meeting.title}`} />
    </li>
  );
}

export function MeetingCalendarList() {
  const settings = useMeetingBotSettings();
  const connected = settings?.calendar === "connected";
  const meetings = useCalendarMeetings(connected);
  const bots = useMeetingBots();
  const setJoinAll = useInboxStore((s) => s.setMeetingBotJoinAll);
  const getGoogleUrl = useAction(api.googleOAuth.getConnectUrl);
  const { busy, error, attempt, openMinted } = useConnectGesture();
  if (!settings) return null;

  if (!connected) {
    const connect = () =>
      void attempt(
        () => openMinted(
          () => getGoogleUrl({ grant: "calendar.events", return_to: "/settings/integrations" }),
          "Couldn't start the Google connection",
        ),
        "Couldn't reach Google",
      );
    return (
      <div className="mt-2.5">
        <button
          type="button"
          onClick={connect}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-sol-border/40 px-3 py-1.5 text-xs text-sol-text-muted transition-colors hover:bg-sol-bg-alt hover:text-sol-text disabled:opacity-50"
        >
          <CalendarDays className="h-3.5 w-3.5" />
          {settings.calendar === "missing_scope" ? "Allow calendar access" : "Connect Google Calendar"}
        </button>
        {error && <p className="mt-1 text-meta text-sol-red">{error}</p>}
      </div>
    );
  }

  const joinAll = settings.join_all;
  const botByMeet = new Map(bots.map((b) => [b.meet_id, b]));
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 text-meta text-sol-text-dim">
        <CalendarDays className="h-3 w-3" />
        <span className="flex-1">Upcoming meetings</span>
        <label className="flex items-center gap-1.5">
          Join all
          <Switch checked={joinAll} onCheckedChange={setJoinAll} aria-label="Send a bot to every meeting with a link" />
        </label>
      </div>
      {meetings.length === 0 ? (
        <p className="mt-1.5 text-meta text-sol-text-dim">No meetings with a link this week</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {meetings.slice(0, 12).map((m) => (
            <MeetingRow key={m._id} meeting={m} joinAll={joinAll} bot={m.meet_id ? botByMeet.get(m.meet_id) ?? null : null} />
          ))}
        </ul>
      )}
    </div>
  );
}
