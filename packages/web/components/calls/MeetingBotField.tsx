import { useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Bot, X } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { sendBotToMeeting } from "../../lib/meetingBots";
import { useInboxStore } from "../../store/inboxStore";
import { useMeetingBots } from "../../hooks/useMeetingBots";
import { MeetingCalendarList } from "./MeetingCalendarList";
import { MEETING_BOT_FINAL, type MeetingBot, type MeetingBotStatus } from "../../store/meetingBotsSlice";

// A Recall.ai bot sent to a meeting on another platform (convex meetingBots.ts).
// The field takes the link; under it, one row per bot still on its way in or
// in the meeting, and the ones that stopped in the last hour so a refusal is
// seen. Once recording, the bot's meeting is an ordinary call: its row opens it.

const STATUS: Record<MeetingBotStatus, { words: string; tone: string }> = {
  requested: { words: "Sending", tone: "text-sol-text-dim" },
  scheduled: { words: "Scheduled", tone: "text-sol-text-muted" },
  joining: { words: "Joining", tone: "text-sol-cyan" },
  waiting_room: { words: "Waiting room", tone: "text-sol-yellow" },
  in_call: { words: "In the call", tone: "text-sol-cyan" },
  recording: { words: "Recording", tone: "text-sol-green" },
  ended: { words: "Ended", tone: "text-sol-text-dim" },
  failed: { words: "Failed", tone: "text-sol-red" },
  cancelled: { words: "Removed", tone: "text-sol-text-dim" },
};

/** The meeting's platform, or the link's host while the server has not named it. */
function platformOf(bot: MeetingBot): string {
  if (bot.platform_name) return bot.platform_name;
  try {
    return new URL(bot.meeting_url).host.replace(/^www\./, "");
  } catch {
    return "Meeting";
  }
}

function MeetingBotRow({ bot }: { bot: MeetingBot }) {
  const cancel = useInboxStore((s) => s.cancelMeetingBot);
  const status = STATUS[bot.status] ?? STATUS.requested;
  const going = !MEETING_BOT_FINAL.has(bot.status);
  const when = bot.status === "scheduled" && bot.join_at
    ? new Date(bot.join_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;
  const body = (
    <>
      <Bot className="h-3 w-3 shrink-0 text-sol-text-dim" aria-hidden="true" />
      <span className="min-w-0 shrink truncate text-sol-text" title={bot.meeting_url}>{platformOf(bot)}</span>
      <span className={`flex min-w-0 flex-1 items-center gap-1.5 ${status.tone}`}>
        {bot.status === "recording" && (
          <span className="relative inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-sol-green ring-2 ring-sol-green/25" aria-hidden="true" />
        )}
        <span className="truncate" title={bot.status_words ?? undefined}>
          {status.words}
          {when && ` ${when}`}
          {bot.status === "failed" && bot.status_words && <span className="text-sol-red/80"> · {bot.status_words}</span>}
        </span>
      </span>
    </>
  );
  return (
    <li className="flex items-center gap-1.5 text-meta" data-meeting-bot={bot.status}>
      {bot.transcript_id ? (
        <Link href={`/calls/${bot.transcript_id}`} className="flex min-w-0 flex-1 items-center gap-1.5 rounded hover:underline">
          {body}
        </Link>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5">{body}</span>
      )}
      {going && bot.meet_id && (
        <button
          type="button"
          onClick={() => cancel(bot.meet_id)}
          title="Remove the bot from the meeting"
          aria-label="Remove the bot from the meeting"
          className="shrink-0 rounded p-0.5 text-sol-text-dim transition-colors hover:bg-sol-bg-alt hover:text-sol-red"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </li>
  );
}

/** The Calls page's meeting section: the link field with the bots it sent,
 *  and the calendar's meetings. Opened as /calls?bot=1 (the palette and New
 *  menu's "Send a bot to a meeting") it takes the cursor. */
export function MeetingBotsSection() {
  return (
    <section className="mt-3 border-t border-sol-border/20 pt-2.5" aria-label="Meetings">
      <div className="flex items-center gap-1.5 text-mark font-medium uppercase tracking-wide text-sol-text-dim">
        <Bot className="h-3 w-3" aria-hidden="true" />
        Meetings
      </div>
      <MeetingBotField />
      <MeetingCalendarList />
    </section>
  );
}

/** "Meeting link" with Send bot, and the bots it sent. */
export function MeetingBotField() {
  const [link, setLink] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const asked = useSearchParams()?.get("bot") === "1";
  useWatchEffect(() => {
    if (asked) inputRef.current?.focus();
  }, [asked]);
  const bots = useMeetingBots();
  const send = () => {
    const url = link.trim();
    if (!url) return;
    setLink("");
    sendBotToMeeting(url, () => setLink((now) => now || url));
  };
  return (
    <div className="mt-2.5">
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Zoom, Meet or Teams link"
          aria-label="Meeting link"
          className="min-w-0 flex-1 rounded-md border border-sol-border/40 bg-sol-bg px-2 py-1.5 text-xs text-sol-text placeholder:text-sol-text-dim focus:border-sol-cyan/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!link.trim()}
          title="A bot joins the meeting and transcribes it into a call here"
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-sol-cyan/15 px-2.5 py-1.5 text-xs font-medium text-sol-cyan transition-colors hover:bg-sol-cyan/25 disabled:opacity-40 disabled:hover:bg-sol-cyan/15"
        >
          <Bot className="h-3.5 w-3.5" />
          Send bot
        </button>
      </form>
      {bots.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {bots.map((b) => <MeetingBotRow key={b._id} bot={b} />)}
        </ul>
      )}
    </div>
  );
}
