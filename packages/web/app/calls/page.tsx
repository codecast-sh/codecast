"use client";

// The calls page: every transcribed huddle as a first-class object — live
// calls streaming at the top, history below, each with its exact
// speaker-attributed transcript and the auto-generated summary/action items.
// Attribution is structural (one audio track = one speaker), so "who said
// what" is never a diarization guess. The same objects are available to
// agents via `cast calls` / `cast call <id>`.
//
// The transcript is a working surface, not a record: select turns (click,
// then shift/click or click again to extend) and hand them to an agent
// session — a fresh one by default, opening beside the page so the agent
// answers inline — and the room's chat sits in a rail next to the words.

import { useTeamFeature } from "../../lib/teamFeatures";
import { useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { toast } from "sonner";
import { humanizeConvexError, isRecRoomKey } from "@codecast/shared/contracts";
import { getRoom, joinCall } from "../../lib/calls/callManager";
import { isConvexId, useInboxStore } from "../../store/inboxStore";
import { Facepile } from "../../components/calls/OccupancyChip";
import { LiveRoomAction, LiveRoomLabel } from "../../components/calls/LiveNow";
import { useLiveRooms } from "../../hooks/useLiveRooms";
import { CallChatPanel } from "../../components/calls/CallChatPanel";
import { FeedChip } from "../../components/calls/FeedChip";
import {
  openFeedTargetPicker,
  useAddLiveFeed,
  useRemoveLiveFeed,
  useSendExcerpt,
  type FeedTarget,
  type TranscriptExcerpt,
} from "../../components/calls/useCallFeed";
import { firstName, fmtClock, speakerColor } from "../../components/calls/speakers";
import { TranscriptTurnList } from "../../components/calls/TranscriptTurns";
import { groupTurns } from "../../components/calls/transcriptTurnModel";
import { useMutation } from "convex/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  Check,
  Lock,
  Phone,
  PhoneCall,
  Radio,
  ListChecks,
  AlignLeft,
  MessageSquare,
  Mic,
  Send,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { getRecorderStatus, startRecording } from "../../lib/calls/recorder";
import { useRecorderStatus } from "../../hooks/useRecorder";
import "../../components/calls/recorder.css";

import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay
    ? time
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

function fmtDuration(startedAt: number, endedAt: number | null): string {
  if (!endedAt) return "live";
  const min = Math.max(1, Math.round((endedAt - startedAt) / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

/** Where a recording of mine stands in triage, at a glance: private (the
 *  birth state) or the team its creator shared it into. Read-only here — the
 *  detail header holds the control. */
function RecordingScopeChip({ call }: { call: any }) {
  const me = useInboxStore((s: any) => s.currentUser?._id?.toString?.() ?? null);
  const teams = useInboxStore((s) => s.teams);
  if (!isRecRoomKey(call.room_key) || !me || call.started_by !== me) return null;
  if (!call.rec_shared) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-sol-text-dim">
        <Lock className="h-2.5 w-2.5" /> private
      </span>
    );
  }
  const team = (teams || []).find((t: any) => String(t._id) === String(call.team_id));
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-sol-cyan">
      <Users className="h-2.5 w-2.5" /> {team?.name ?? "team"}
    </span>
  );
}

function CallListRow({ call, selected }: { call: any; selected: boolean }) {
  const live = call.status === "live";
  // A recording sits in the same list under the same idiom — it is a call
  // object like any other — and the glyph is the whole difference: a
  // microphone rather than a telephone, because one voice in a room is not
  // the same thing as a huddle.
  const recording = isRecRoomKey(call.room_key);
  const people: any[] = call.participants || [];
  return (
    <Link
      href={`/calls/${call._id}`}
      className={`block border-b border-sol-border/15 px-4 py-3 transition-colors hover:bg-sol-bg-alt/40 ${
        selected ? "border-l-2 border-l-sol-cyan bg-sol-bg-alt/60" : "border-l-2 border-l-transparent"
      }`}
    >
      <div className="flex items-center gap-2">
        {live ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-green opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sol-green" />
          </span>
        ) : recording ? (
          <Mic className="h-3 w-3 shrink-0 text-sol-text-dim" />
        ) : (
          <Phone className="h-3 w-3 shrink-0 text-sol-text-dim" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-sol-text">
          {call.title || (recording ? "Untitled recording" : "Untitled huddle")}
        </span>
        <span className={`shrink-0 text-[11px] ${live ? "text-sol-green" : "text-sol-text-dim"}`}>
          {fmtDuration(call.started_at, call.ended_at)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-4">
        <span className="shrink-0 text-[11px] text-sol-text-dim">{fmtWhen(call.started_at)}</span>
        <RecordingScopeChip call={call} />
        {people.length === 0 ? (
          <span className="text-[11px] italic text-sol-text-dim">
            {live
              ? recording
                ? "listening"
                : "no one spoke yet"
              : recording
                ? "nothing was said"
                : "no one spoke"}
          </span>
        ) : (
          <span className="min-w-0 truncate text-[11px]">
            {people.map((p: any, i: number) => (
              <span key={p.id} className={speakerColor(p.id)}>
                {firstName(p.name)}
                {i < people.length - 1 ? ", " : ""}
              </span>
            ))}
          </span>
        )}
      </div>
    </Link>
  );
}

/** The triage control: a recording starts private to its creator, and this is
 *  where they file it into a team (or take it back). Creator-only — for
 *  everyone else the scope is a fact, not a knob — and the server enforces
 *  the same rule (transcripts.setRecordingScope). */
function RecordingScopePicker({ call }: { call: any }) {
  const me = useInboxStore((s: any) => s.currentUser?._id?.toString?.() ?? null);
  const teams = useInboxStore((s) => s.teams);
  const setScope = useMutation(api.transcripts.setRecordingScope);
  if (!isRecRoomKey(call.room_key) || !me || call.started_by !== me) return null;

  // A just-created team carries an optimistic stub id until the server row
  // lands; sharing against it would 404 — same rule as TeamSwitcher's invite.
  const shareable = (teams || []).filter((t: any) => isConvexId(String(t._id)));
  const sharedTeam = call.rec_shared
    ? (teams || []).find((t: any) => String(t._id) === String(call.team_id))
    : null;
  const pick = (teamId: string | null) =>
    void setScope({
      transcript_id: call._id,
      ...(teamId ? { team_id: teamId as any } : {}),
    }).catch((err) => toast.error(humanizeConvexError(err)));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors ${
            call.rec_shared
              ? "border-sol-cyan/40 text-sol-cyan hover:bg-sol-cyan/10"
              : "border-sol-border text-sol-text-dim hover:text-sol-text"
          }`}
          title="Who can open this recording"
        >
          {call.rec_shared ? (
            <>
              <Users className="h-3 w-3" /> {sharedTeam?.name ?? "team"}
            </>
          ) : (
            <>
              <Lock className="h-3 w-3" /> private
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Who can open this recording</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => pick(null)}>
          <Lock className="mr-1.5 h-3.5 w-3.5" /> Only you
          {!call.rec_shared && <Check className="ml-auto h-3.5 w-3.5" />}
        </DropdownMenuItem>
        {shareable.map((t: any) => (
          <DropdownMenuItem key={String(t._id)} onClick={() => pick(String(t._id))}>
            <Users className="mr-1.5 h-3.5 w-3.5" /> {t.name}
            {call.rec_shared && String(call.team_id) === String(t._id) && (
              <Check className="ml-auto h-3.5 w-3.5" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CallDetail({ id }: { id: string }) {
  // Plain useQuery: a live call's transcript streams into this subscription
  // in real time — segments appear as people speak.
  const call = useQuery(api.transcripts.webGetCall, { transcript_id: id as any });
  const myCall = useInboxStore((s) => s.call);
  // A recording has no room: nobody can join it, nobody else can see it, and
  // the room chat those affordances open would have no second person in it.
  const recording = isRecRoomKey(call?.room_key);
  const sendExcerpt = useSendExcerpt();
  // Live-feed parity with the stage: on a LIVE call this page can point the
  // flowing words at a session/doc too — the transcript already runs (this
  // row IS the live transcript), so it is addRoute all the way down.
  const isLive = call?.status === "live";
  const addFeed = useAddLiveFeed({
    roomKey: call?.room_key ?? null,
    liveTranscriptId: isLive ? id : null,
    getRoom,
  });
  const removeFeed = useRemoveLiveFeed(isLive ? id : null);
  const myUserId = useInboxStore((s: any) => s.currentUser?._id?.toString?.() ?? null);

  // Closed by default: the transcript owns the width until the reader asks
  // for the chat lane (the calls page often shares the shell with other
  // rails, so three fixed columns cannot all be on by default).
  const [chatOpen, setChatOpen] = useState(false);
  // Selection: an anchor turn and an end turn — a contiguous range, like
  // text selection but snapped to speaker turns.
  const [anchor, setAnchor] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [sentTick, setSentTick] = useState<string | null>(null);

  const turns = useMemo(() => groupTurns(call?.segments ?? []), [call?.segments]);
  const [selLo, selHi] =
    anchor === null ? [null, null] : end === null ? [anchor, anchor] : [Math.min(anchor, end), Math.max(anchor, end)];
  const selectedCount = selLo === null ? 0 : (selHi as number) - selLo + 1;

  const clearSelection = () => {
    setAnchor(null);
    setEnd(null);
  };

  useMountEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Selection resets when the viewer moves to another call.
  useWatchEffect(() => clearSelection(), [id]);

  const live = isLive;

  // Live transcripts follow the tail while the reader is near the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const segCount = call?.segments?.length ?? 0;
  useWatchEffect(() => {
    const el = scrollRef.current;
    if (!el || !live) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 240;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [segCount, live]);

  if (call === undefined) {
    return <div className="p-8 text-sm text-sol-text-dim">Loading…</div>;
  }
  if (call === null) {
    return <div className="p-8 text-sm text-sol-text-dim">Call not found (or not yours to see).</div>;
  }

  const inThisRoom = myCall.roomKey === call.room_key && myCall.phase === "connected";

  const buildExcerpt = (which: "selection" | "all"): TranscriptExcerpt => {
    const chosen =
      which === "selection" && selLo !== null
        ? turns.slice(selLo, (selHi as number) + 1).flatMap((t) => t.segments)
        : (call.segments ?? []);
    return {
      segments: chosen,
      title: call.title,
      startedAt: call.started_at,
      live,
      partial: which === "selection" && selectedCount > 0 && selectedCount < turns.length,
    };
  };

  const onPick = (which: "selection" | "all") => (t: FeedTarget, note?: string) => {
    const excerpt = buildExcerpt(which);
    void sendExcerpt(t, excerpt, note).then(() => {
      setSentTick(t.kind === "new-doc" ? "saved to doc" : "sent — agent replies in the side panel");
      setTimeout(() => setSentTick(null), 3500);
    });
    if (which === "selection") clearSelection();
  };

  const isSelected = (i: number) => selLo !== null && i >= selLo && i <= (selHi as number);
  const onTurnClick = (i: number, e: React.MouseEvent) => {
    if (anchor === null) return setAnchor(i);
    if (e.shiftKey || anchor !== null) {
      if (i === anchor && end === null) return clearSelection();
      setEnd(i);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {/* Header: what this call was, who spoke, the ways in. */}
        <div className="shrink-0 border-b border-sol-border/20 px-6 py-4">
          <div className="flex items-center gap-2.5">
            {recording && <Mic className="h-4 w-4 shrink-0 text-sol-text-dim" />}
            <h1 className="min-w-0 truncate text-[17px] font-medium text-sol-text">
              {call.title || (recording ? "Untitled recording" : "Untitled huddle")}
            </h1>
            {live && (
              <span
                className={`flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${
                  recording ? "text-sol-red" : "text-sol-green"
                }`}
              >
                <Radio className="h-3.5 w-3.5" /> {recording ? "RECORDING" : "LIVE"}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-sol-text-dim">
            <span>{fmtWhen(call.started_at)}</span>
            <span>{fmtDuration(call.started_at, call.ended_at)}</span>
            <RecordingScopePicker call={call} />
            {(call.participants || []).length > 0 && (
              <span className="flex flex-wrap items-center gap-1.5">
                {(call.participants || []).map((p: any) => (
                  <span
                    key={p.id}
                    className={`rounded-md bg-sol-bg-alt/60 px-1.5 py-0.5 font-mono text-[11px] ${speakerColor(p.id)}`}
                  >
                    {firstName(p.name)}
                  </span>
                ))}
              </span>
            )}
            {live &&
              (call.routes ?? [])
                .filter((r: any) => r.kind !== "slack" || r.target)
                .map((r: any) => (
                  <FeedChip
                    key={`${r.kind}:${r.target}`}
                    route={r}
                    removable={!!myUserId && r.added_by === myUserId}
                    onRemove={() => void removeFeed(r.kind, r.target)}
                  />
                ))}
            {live && (
              <button
                onClick={() =>
                  openFeedTargetPicker({
                    title: "Feed the live words to…",
                    gesture: "feed",
                    showSlack: true,
                    onPick: (t) =>
                      void addFeed(t).catch((err) =>
                        toast.error(humanizeConvexError(err)),
                      ),
                  })
                }
                className="flex items-center gap-1 rounded-md border border-dashed border-sol-violet/50 px-2 py-0.5 font-mono text-[11px] text-sol-violet transition-colors hover:bg-sol-violet/10"
                title="Point the live transcript at an agent session, doc, or Slack"
              >
                <Radio className="h-3 w-3" />
                feed
              </button>
            )}
            {sentTick && <span className="text-sol-green">{sentTick}</span>}
            <span className="flex-1" />
            {live && !recording && !inThisRoom && (
              <button
                onClick={() => void joinCall(call.room_key, { intent: "deliberate" })}
                className="flex shrink-0 items-center gap-1.5 rounded-md bg-sol-green/15 px-3 py-1.5 text-xs font-medium text-sol-green transition-colors hover:bg-sol-green/25"
              >
                <PhoneCall className="h-3.5 w-3.5" /> Join
              </button>
            )}
            <button
              onClick={() =>
                openFeedTargetPicker({ title: "Send the whole call to…", gesture: "send", withNote: true, onPick: onPick("all") })
              }
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-sol-violet/15 px-3 py-1.5 text-xs font-medium text-sol-violet transition-colors hover:bg-sol-violet/25"
              title="Send the whole transcript to an agent session or doc"
            >
              <Sparkles className="h-3.5 w-3.5" /> Send to agent
            </button>
            {/* No room, so no room chat: a recording has nobody else in it. */}
            {!recording && (
              <button
                onClick={() => setChatOpen((o) => !o)}
                className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                  chatOpen
                    ? "bg-sol-cyan/15 text-sol-cyan"
                    : "text-sol-text-muted hover:bg-sol-base02 hover:text-sol-text"
                }`}
                title="Chat with the room"
              >
                <MessageSquare className="h-3.5 w-3.5" /> Chat
              </button>
            )}
          </div>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {call.summary && (
            <div className="mb-5 rounded-lg border border-sol-border/25 bg-sol-bg-alt/40 px-4 py-3">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
                <AlignLeft className="h-3 w-3" /> Summary
              </div>
              <p className="text-[13px] leading-relaxed text-sol-text">{call.summary}</p>
              {(call.action_items || []).length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
                    <ListChecks className="h-3 w-3" /> Action items
                  </div>
                  <ul className="space-y-1">
                    {call.action_items.map((a: string, i: number) => (
                      <li key={i} className="flex gap-2 text-[13px] text-sol-text">
                        <span className="text-sol-cyan">→</span>
                        <span>{a}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {!call.summary && !live && (
            <div className="mb-5 text-[12px] text-sol-text-dim">
              {call.summary_status === "skipped"
                ? "Too short to summarize."
                : call.summary_status === "failed"
                  ? "Summary generation failed."
                  : "Summary pending…"}
            </div>
          )}

          {call.recording_url && (
            <div className="mb-5">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
                <Mic className="h-3 w-3" /> Audio
              </div>
              <audio controls preload="none" src={call.recording_url} className="w-full max-w-lg" />
            </div>
          )}

          {turns.length === 0 ? (
            <div className="text-sm text-sol-text-dim">
              {live
                ? recording
                  ? "Listening — the transcript appears as people speak. Your microphone hears the room."
                  : "Listening — the transcript appears as people speak."
                : "Nothing was transcribed."}
            </div>
          ) : (
            <>
              {selectedCount === 0 && (
                <div className="mb-2 text-[10.5px] text-sol-text-dim/80">
                  Click a turn to start a selection, click another to extend — then send the
                  excerpt to an agent.
                </div>
              )}
              <div className="space-y-0.5 pb-20">
                <TranscriptTurnList turns={turns} isSelected={isSelected} onTurnClick={onTurnClick} />
              </div>
            </>
          )}
        </div>

        {/* The selection action bar: an in-flow footer, never absolute — the
            tab shell's transformed ancestors hijack absolute/fixed containing
            blocks (the fixed-under-transform trap). */}
        {selectedCount > 0 && (
          <div className="z-20 flex shrink-0 justify-center border-t border-sol-border/20 py-2.5">
            <div className="relative flex items-center gap-2 rounded-xl border border-sol-border bg-sol-bg-alt px-3 py-2 shadow-2xl">
              <span className="text-[12px] text-sol-text-muted">
                {selectedCount} turn{selectedCount === 1 ? "" : "s"} selected
              </span>
              <button
                onClick={() =>
                  openFeedTargetPicker({
                    title: `Send ${selectedCount} turn${selectedCount === 1 ? "" : "s"} to…`,
                    gesture: "send",
                    withNote: true,
                    onPick: onPick("selection"),
                  })
                }
                className="flex items-center gap-1.5 rounded-md bg-sol-violet/15 px-2.5 py-1 text-[12px] font-medium text-sol-violet transition-colors hover:bg-sol-violet/25"
              >
                <Send className="h-3 w-3" /> Send to agent
              </button>
              <button
                onClick={clearSelection}
                className="rounded p-1 text-sol-text-dim transition-colors hover:text-sol-text"
                title="Clear selection (Esc)"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* The room's chat, beside the words that prompted it. */}
      {chatOpen && call.room_key && (
        <aside className="flex w-[280px] shrink-0 flex-col border-l border-sol-border/20">
          <div className="flex shrink-0 items-center gap-1.5 border-b border-sol-border/20 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
            <MessageSquare className="h-3 w-3" /> Room chat
          </div>
          <CallChatPanel roomKey={call.room_key} className="min-h-0 flex-1" />
        </aside>
      )}
    </div>
  );
}

// Rooms with someone seated RIGHT NOW — the same list the sidebar's Live now
// cluster reads (calls.getLiveRooms via the store), so the two can never
// disagree. A transcribed live call already pulses in the Live section below;
// this covers the huddles nobody toggled Transcribe on, which under open rooms
// is most of them. Locked rooms list too — seeing one is what makes knocking
// possible — with Knock in place of Join for the people the lock shuts out.
function LiveNowSection({ transcribedRoomKeys }: { transcribedRoomKeys: Set<string> }) {
  const rooms = useLiveRooms().filter((r) => !transcribedRoomKeys.has(r.roomKey));
  if (rooms.length === 0) return null;
  return (
    <>
      <div className="bg-sol-bg-alt/30 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-violet">
        Happening now
      </div>
      {rooms.map((row) => (
        <div
          key={row.roomKey}
          className="flex items-center gap-2 border-b border-sol-border/15 px-4 py-3"
        >
          <Facepile members={row.members} max={4} size={22} />
          <div className="min-w-0 flex-1">
            <LiveRoomLabel row={row} className="text-[13px] font-medium text-sol-text" />
            <div className="mt-0.5 min-w-0 truncate text-[11px] text-sol-text-dim">
              {row.members.map((m) => firstName(m.user_name)).join(", ")}
            </div>
          </div>
          <LiveRoomAction row={row} />
        </div>
      ))}
    </>
  );
}

/**
 * Start a recording. The only way one ever begins on this page, and it says in
 * as many words where the sound comes from: a microphone in a room, not a tap
 * on the meeting software. Once running, the pill takes over — this button
 * points at the transcript instead of offering a second stop control that
 * could disagree with the one people already found.
 */
function RecordMeetingButton() {
  const status = useRecorderStatus();
  const router = useRouter();
  const running = status.phase === "recording" || status.phase === "stopping";
  const starting = status.phase === "starting";

  if (running) {
    return (
      <button
        onClick={() => status.transcriptId && router.push(`/calls/${status.transcriptId}`)}
        className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-md border border-sol-red/50 bg-sol-red/12 px-3 py-2 text-xs font-medium text-sol-red transition-colors hover:bg-sol-red/20"
      >
        <span className="rec-pill-dot" aria-hidden="true" />
        Recording — open the transcript
      </button>
    );
  }

  return (
    <button
      onClick={() =>
        void startRecording().then((id) => {
          // A refused microphone is the common failure and the pill is not up
          // to carry the news — nothing started, so nothing is showing.
          if (id) router.push(`/calls/${id}`);
          else if (getRecorderStatus().error) toast.error(getRecorderStatus().error!);
        })
      }
      disabled={starting}
      title="Records what your microphone hears — the room, and anything playing through your speakers"
      className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-md bg-sol-red/15 px-3 py-2 text-xs font-medium text-sol-red transition-colors hover:bg-sol-red/25 disabled:opacity-50"
    >
      <Mic className="h-3.5 w-3.5" />
      {/* The wait here is a person deciding, not a machine working: Chrome is
          asking them for the microphone and nothing moves until they answer.
          Saying "Starting…" made an unanswered prompt look like a hang. */}
      {starting ? "Waiting for the microphone" : "Record a meeting"}
    </button>
  );
}

export default function CallsPage() {
  const params = useParams() as { id?: string };
  const selectedId = params?.id ?? null;
  const callsOn = useTeamFeature("calls");
  // Always asked, whatever the ACTIVE team's calls feature says: recordings
  // are personal — they land here from every team and from none — and the
  // server already answers with exactly what this viewer may read (a huddle
  // only under its own team's feature gate, a recording under its creator's
  // ownership). Gating the query on the active team made someone's private
  // recordings vanish when they switched teams.
  const calls = useQueryNoThrow(api.transcripts.webListCalls, { limit: 100 }).data as
    | any[]
    | undefined;
  const { liveCalls, pastCalls, transcribedRoomKeys } = useMemo(() => {
    const rows = calls ?? [];
    const live = rows.filter((r) => r.status === "live");
    return {
      liveCalls: live,
      pastCalls: rows.filter((r) => r.status !== "live"),
      transcribedRoomKeys: new Set<string>(live.map((r) => r.room_key).filter(Boolean)),
    };
  }, [calls]);

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="flex h-full min-h-0">
          <div className="flex w-72 shrink-0 flex-col border-r border-sol-border/20">
            <div className="shrink-0 border-b border-sol-border/20 px-4 py-3">
              <h2 className="text-sm font-medium text-sol-text">Calls</h2>
              <p className="mt-0.5 text-[11px] text-sol-text-dim">
                Transcribed huddles and recordings — also via{" "}
                <code className="text-sol-cyan">cast calls</code>
              </p>
              <RecordMeetingButton />
              <p className="mt-1.5 text-[10.5px] leading-snug text-sol-text-dim/80">
                Records from your microphone. A recording starts private to
                you, whatever team is active — share it into a team from its
                page when it belongs there.
              </p>
              {!callsOn && (
                <p className="mt-1.5 text-[10.5px] leading-snug text-sol-yellow/80">
                  Huddles are off for this team (a team admin can turn them on
                  under Settings → Team). Your recordings stay here either way.
                </p>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {callsOn && <LiveNowSection transcribedRoomKeys={transcribedRoomKeys} />}
              {calls === undefined ? (
                <div className="p-4 text-[12px] text-sol-text-dim">Loading…</div>
              ) : calls.length === 0 ? (
                <div className="p-4 text-[12px] leading-relaxed text-sol-text-dim">
                  Nothing here yet. Start a huddle and toggle Transcribe, or
                  record the meeting in the room around you — either lands here
                  with a live transcript and, when it ends, a summary and
                  action items.
                </div>
              ) : (
                <>
                  {liveCalls.length > 0 && (
                    <div className="bg-sol-bg-alt/30 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-green">
                      Live ({liveCalls.length})
                    </div>
                  )}
                  {liveCalls.map((r) => (
                    <CallListRow key={r._id} call={r} selected={r._id === selectedId} />
                  ))}
                  {pastCalls.length > 0 && (
                    <div className="bg-sol-bg-alt/30 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
                      History
                    </div>
                  )}
                  {pastCalls.map((r) => (
                    <CallListRow key={r._id} call={r} selected={r._id === selectedId} />
                  ))}
                </>
              )}
            </div>
          </div>
          <div className="relative min-w-0 flex-1">
            {selectedId ? (
              <CallDetail id={selectedId} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-center text-sol-text-dim">
                  <Phone className="mx-auto mb-2 h-6 w-6 opacity-40" />
                  <div className="text-sm">Select a call</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
