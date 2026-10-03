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
// answers inline. The words, the room's typed lines, the agents' answers
// and the recap read as one thread (components/calls/RoomThread.tsx).

import { isCallLive } from "../../lib/calls/callStatus";
import { useTeamFeature } from "../../lib/teamFeatures";
import { useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@codecast/convex/convex/_generated/api";
import { ShareControl } from "../../components/ShareControl";
import { GuestInvite } from "../../components/calls/GuestDoor";
import { GuestTag, ParticipantTag } from "../../components/calls/GuestTag";
import { isGuestParticipant } from "../../lib/calls/roomGuests";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCallDetail, useCallList } from "../../hooks/useSyncCalls";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { toast } from "sonner";
import { humanizeConvexError, isRecRoomKey, parseCallAnchor, parseCallMomentParam, parseCallViewParam } from "@codecast/shared/contracts";
import { callRefId } from "@codecast/shared/entities";
import { joinCall } from "../../lib/calls/callManager";
import { callTitle } from "../../lib/calls/roomLabels";
import { isConvexId, useInboxStore } from "../../store/inboxStore";
import { Facepile } from "../../components/calls/OccupancyChip";
import { LiveRoomAction, LiveRoomLabel } from "../../components/calls/LiveNow";
import { useLiveRooms } from "../../hooks/useLiveRooms";
import { RoomThread } from "../../components/calls/RoomThread";
import { buildPassages, flatTurns, type ThreadRow } from "../../components/calls/roomThreadModel";
import { turnsAnchor } from "../../components/calls/transcriptTurnModel";
import { copyCallFrameLink, copyCallLink } from "../../lib/calls/callLinks";
import { copyText } from "../../lib/copyText";
import { scrollIntoContainer } from "../../lib/scrollWithin";
import { callVideoNotice, callVideoRuns, playableFiles, shownMomentNear, turnIndexAt, type CallVideoRun } from "../../lib/calls/callVideo";
import { deleteRecordingRun, toVideoFile, useCallRecordings, useRoomRecordingOn } from "../../hooks/useRoomRecording";
import {
  CallVideoNoticeLine,
  CallVideoPlaceholder,
  CallVideoPlayer,
  DeleteRecordingButton,
  type CallVideoHandle,
} from "../../components/calls/CallVideoPlayer";
import { ShareVideoSwitch } from "../../components/calls/ShareVideoSwitch";
import {
  openFeedTargetPicker,
  useSendExcerpt,
  type FeedTarget,
  type TranscriptExcerpt,
} from "../../components/calls/useCallFeed";
import { firstName, fmtCallLength, fmtClock, speakerColor } from "../../components/calls/speakers";
import { CallSessionChips } from "../../components/calls/CallSessionChips";
import { useMutation } from "convex/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  ArrowDownToLine,
  Check,
  ChevronLeft,
  Copy,
  Link2,
  Lock,
  Phone,
  PhoneCall,
  Radio,
  Mic,
  Send,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import { getRecorderStatus, startRecording } from "../../lib/calls/recorder";
import { useRecorderStatus } from "../../hooks/useRecorder";
import "../../components/calls/recorder.css";
import "../../components/calls/callMedia.css";

import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMediaMoment } from "../../hooks/useMediaMoment";
import { seekCallMedia, useCallMomentLanding, type CallMediaTarget } from "../../hooks/useCallMomentLanding";
import { RecordingMark } from "../../components/calls/RecordingMark";
import { RecorderMic } from "../../components/calls/RecorderMic";
import { fmtClock as fmtWhen } from "../../components/triggerCadence";

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
  const live = isCallLive(call);
  // A recording sits in the same list under the same idiom — it is a call
  // object like any other — and the glyph is the whole difference: a
  // microphone rather than a telephone, because one voice in a room is not
  // the same thing as a huddle.
  const recording = isRecRoomKey(call.room_key);
  const people: any[] = call.participants || [];
  const silent = !recording && !live && people.length === 0;
  // A string out of the selector, so the row re-renders only when the name
  // itself changes, not on every write to the collections it reads.
  const title = useInboxStore((s) =>
    callTitle(call, s as any, { untitled: silent ? "Typed huddle, nothing said" : undefined }),
  );
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
        {/* An ended huddle nobody spoke in is only listed when something was
            typed or answered in it (the history drops empty ones), so it says
            that, quietly, and the eye lands on the calls with a name. */}
        <span
          className={`min-w-0 flex-1 truncate text-[13px] ${
            silent ? "font-normal text-sol-text-muted" : "font-medium text-sol-text"
          }`}
        >
          {title}
        </span>
        <span className={`shrink-0 text-[11px] ${live ? "text-sol-green" : "text-sol-text-dim"}`}>
          {fmtCallLength(call.started_at, call.ended_at)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-4">
        <span className="shrink-0 text-[11px] text-sol-text-dim">{fmtWhen(call.started_at)}</span>
        <RecordingScopeChip call={call} />
        {recording ? (
          // One microphone never fills participants, so the row reads the
          // transcript itself: how many lines it has, or where it stands.
          <span className="text-[11px] italic text-sol-text-dim">
            {call.last_seq > 0
              ? `${call.last_seq} line${call.last_seq === 1 ? "" : "s"}`
              : live
                ? "listening"
                : call.transcribe_status === "pending"
                  ? "transcribing…"
                  : "nothing was said"}
          </span>
        ) : live && people.length === 0 ? (
          <span className="text-[11px] italic text-sol-text-dim">no one spoke yet</span>
        ) : silent ? null : (
          <span className="min-w-0 truncate text-[11px]">
            {people.map((p: any, i: number) => (
              <span key={p.id} className={speakerColor(p.id)}>
                {firstName(p.name)}
                <ParticipantTag identity={p.id} name={p.name} className="ml-1 align-[1px]" />
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

/** The call page before its record answers: the header painted from the
 *  history list's row when the list has it (title, when, how long), and the
 *  thread's shape under it, so the page does not open on a word and then
 *  jump. Only the header is drawn from the row; nothing else is guessed (no
 *  video box, since the list cannot say whether the call was filmed). */
function CallDetailSkeleton({ preview }: { preview?: any }) {
  const bar = "rounded bg-sol-text-muted/10 animate-pulse motion-reduce:animate-none";
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col" aria-busy="true">
      <div className="shrink-0 border-b border-sol-border/20 px-6 py-4">
        {preview?.title ? (
          <h1 className="min-w-0 line-clamp-2 text-[17px] font-medium leading-snug text-sol-text">{preview.title}</h1>
        ) : (
          <div className={`${bar} h-[22px] w-72 max-w-full`} />
        )}
        <div className="mt-2 flex items-center gap-3 text-[12px] text-sol-text-dim">
          {preview?.started_at ? (
            <>
              <span>{fmtWhen(preview.started_at)}</span>
              <span>{fmtCallLength(preview.started_at, preview.ended_at)}</span>
            </>
          ) : (
            <div className={`${bar} h-3.5 w-40`} />
          )}
        </div>
      </div>
      <div className="space-y-4 px-6 pt-5" aria-hidden="true">
        {[64, 88, 52, 76, 40].map((w, i) => (
          <div key={i} className="flex gap-2.5">
            <div className={`${bar} mt-0.5 h-4 w-4 shrink-0 rounded-full`} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className={`${bar} h-3 w-20`} />
              <div className={`${bar} h-3`} style={{ width: `${w}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CallDetail({ id, preview }: { id: string; preview?: any }) {
  // A live call's transcript streams into this subscription in real time
  // (segments appear as people speak), and every push lands in the store, so
  // a call opened before paints from cache on the next visit instead of a
  // skeleton.
  const call = useCallDetail(id);
  const myCall = useInboxStore((s) => s.call);
  // A recording has no room: nobody can join it, nobody else can see it, and
  // the room chat those affordances open would have no second person in it.
  const recording = isRecRoomKey(call?.room_key);
  const sendExcerpt = useSendExcerpt();
  const isLive = call?.status === "live";
  // This huddle's thread: what was typed and what the agents answered. Read
  // here, not in the thread, because the passages the thread folds the words
  // into break on these lines, and the selection below indexes those same
  // passages' turns.
  const rows = useQueryNoThrow(
    api.callChat.list,
    call?.room_key && !recording ? { room_key: call.room_key, transcript_id: call._id } : "skip",
  ).data as ThreadRow[] | null | undefined;

  // Selection: an anchor turn and an end turn — a contiguous range, like
  // text selection but snapped to speaker turns.
  const [anchor, setAnchor] = useState<number | null>(null);
  const [end, setEnd] = useState<number | null>(null);
  const [sentTick, setSentTick] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);

  // The huddle's video (convex callRecordings, read through the store). A
  // recording ("rec:") has its own audio and never a video, so it is not
  // asked. A run deleted here leaves the page in the same frame (store
  // deleteCallRecording) and comes back, with the reason, if the server
  // refuses. Asked by the call's full id, the name every other surface asks
  // under (the share switch, a frame embed), though the page may have been
  // opened as `cl-42`: one question, so one subscription between them.
  const callRecs = useCallRecordings(recording || !call ? null : String(call._id));
  // The room is being filmed right now: the store's flag, the one the rail's
  // row for the same room reads, so the header says it in the same frame.
  const roomRecording = useRoomRecordingOn(call?.room_key);
  const videoFiles = useMemo(() => (callRecs?.recordings ?? []).map(toVideoFile), [callRecs]);
  const hasVideo = useMemo(() => playableFiles(videoFiles).length > 0, [videoFiles]);
  const videoRuns = useMemo(() => callVideoRuns(videoFiles), [videoFiles]);
  const videoNotice = callVideoNotice(videoRuns);
  const playerRef = useRef<CallVideoHandle | null>(null);
  // A moment asked for (a line clicked, a `?t=` link) that no video shows:
  // said under the picture until the next seek that lands, so the picture
  // and the lit line never disagree without a word.
  const [missed, setMissed] = useState<number | null>(null);
  const removeRun = (run: CallVideoRun) => {
    const anyId = run.composite?.id ?? run.screens[0]?.id;
    if (anyId) deleteRecordingRun(anyId);
  };
  // Media the transcript follows: the audio of a recording, the video of a
  // recorded huddle. Either makes a click on a line a seek.
  const seekable = recording || hasVideo;
  const detailRef = useRef<HTMLDivElement>(null);
  // The passages are the thread's model of the words, so the flat turn list
  // the selection indexes is exactly what the thread renders, in order.
  const segments = call?.segments;
  const turns = useMemo(
    () => flatTurns(buildPassages(segments ?? [], (rows ?? []).map((r) => r.at), { recording })),
    [segments, rows, recording],
  );
  // Where the call's media is (ms since the call started) and whether it is
  // playing: the audio of a recording, or the video of a recorded huddle.
  // The line being said lights from this, and the page re-renders only when
  // that line (or play and pause) moves.
  const media = useMediaMoment(turns);
  const mediaAt = media.at;
  const setMediaAt = media.set;
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

  // Selection, and where the media stood, reset when the viewer moves to
  // another call.
  useWatchEffect(() => {
    clearSelection();
    setMediaAt(null);
    setMissed(null);
    setFollowing(true);
  }, [id]);

  // A link into the call (callAnchorHref): turns open selected, the recap's
  // summary or an action item opens the recap. The thread scrolls to it.
  const searchParams = useSearchParams();
  const focus = useMemo(() => parseCallAnchor(searchParams), [searchParams]);
  const landed = useRef<string | null>(null);
  useWatchEffect(() => {
    if (focus?.kind !== "turns" || turns.length === 0) return;
    const key = `${id}:${focus.from_seq}-${focus.to_seq}`;
    if (landed.current === key) return;
    const hit = turns
      .map((t, i) => (t.segments.some((sg: any) => sg.seq >= focus.from_seq && sg.seq <= focus.to_seq) ? i : -1))
      .filter((i) => i >= 0);
    if (hit.length === 0) return;
    landed.current = key;
    setAnchor(hit[0]);
    setEnd(hit[hit.length - 1]);
  }, [id, focus, turns]);

  // A link to a moment (`?t=754`, what `cl-42@12:34` opens) lands there
  // (useCallMomentLanding), once the recordings have answered whether there
  // is video.
  const momentMs = useMemo(() => parseCallMomentParam(searchParams), [searchParams]);
  // And on the picture it names: a frame of a shared screen opens on that
  // screen, not on the room the player otherwise starts from.
  const momentView = useMemo(() => parseCallViewParam(searchParams), [searchParams]);
  const mediaTarget: CallMediaTarget = { hasVideo, player: playerRef, audio: audioRef, media, setMissed };
  useCallMomentLanding({
    scope: id,
    momentMs,
    view: momentView,
    turns,
    ready: recording || callRecs !== undefined,
    target: mediaTarget,
    lineEl: (i) => lineEl(i),
  });

  // While it plays, the thread follows the line being said, the way lyrics
  // follow a song: only while the reader is following. A wheel or a touch in
  // the thread is the reader reading something else, and so is a line that
  // went out of view without the page moving it there; the page then leaves
  // the scroll alone and offers the way back. A line clicked, or the way
  // back taken, follows again.
  const lineEl = (i: number) => detailRef.current?.querySelector<HTMLElement>(`[data-turn="${i}"]`) ?? null;
  const withLine = (i: number, fn: (el: HTMLElement) => void) => {
    const el = lineEl(i);
    if (el) fn(el);
  };
  const [following, setFollowing] = useState(true);
  const playingIndex = seekable && mediaAt?.playing ? turnIndexAt(turns, mediaAt.ms) : null;
  const followedIndex = useRef<number | null>(null);
  useWatchEffect(() => {
    if (playingIndex === null) return;
    const prev = followedIndex.current;
    followedIndex.current = playingIndex;
    if (!following) return;
    const root = threadRef.current?.getBoundingClientRect();
    const was = prev === null ? null : lineEl(prev)?.getBoundingClientRect();
    if (root && was && (was.bottom < root.top || was.top > root.bottom)) return setFollowing(false);
    withLine(playingIndex, (el) => scrollIntoContainer(el, { block: "nearest", smooth: true }));
  }, [playingIndex]);
  const threadRef = useRef<HTMLDivElement>(null);
  const threadShown = !!call;
  useWatchEffect(() => {
    const root = threadRef.current;
    if (!root) return;
    const away = () => setFollowing(false);
    root.addEventListener("wheel", away, { passive: true });
    root.addEventListener("touchmove", away, { passive: true });
    return () => {
      root.removeEventListener("wheel", away);
      root.removeEventListener("touchmove", away);
    };
  }, [threadShown]);
  const backToMoment = () => {
    setFollowing(true);
    const i = mediaAt ? turnIndexAt(turns, mediaAt.ms, true) : null;
    if (i !== null) withLine(i, (el) => scrollIntoContainer(el, { block: "center", smooth: true }));
  };

  const live = isLive;

  // Named by the one rule the history list uses, so a row and the page it
  // opens never call the same call two things.
  const title = useInboxStore((s) => (call ? callTitle(call, s as any) : ""));
  if (call === undefined) return <CallDetailSkeleton preview={preview} />;
  if (call === null) {
    return <div className="p-8 text-sm text-sol-text-dim">Call not found (or not yours to see).</div>;
  }

  const inThisRoom = myCall.roomKey === call.room_key && myCall.phase === "connected";
  // The people row lists who was heard (participants, the voices the
  // scribe transcribed). Outsiders are the one group the room let in on
  // purpose, so the ones not heard are listed too, apart, as guests: the
  // record's attendance, matched to the speakers by identity on the server
  // (callGuestsOnRecord's `spoke`), so two guests who typed one name stay
  // two and a guest who renamed is listed once. "Did not speak" is only said
  // when the whole call was transcribed and is over: otherwise silence on
  // the record is not silence in the room.
  const silentGuests: Array<{ name: string; joined_at: number }> = (call.guests ?? []).filter((g: { spoke?: boolean }) => !g.spoke);
  const heardAll = !live && (segments?.length ?? 0) > 0 && !(rows ?? []).some((r) => r.event === "transcribe_off" && (!r.transcript_id || r.transcript_id === String(call._id)));

  const buildExcerpt = (which: "selection" | "all"): TranscriptExcerpt => {
    const chosen =
      which === "selection" && selLo !== null
        ? turns.slice(selLo, (selHi as number) + 1).flatMap((t) => t.segments)
        : (call.segments ?? []);
    return {
      segments: chosen,
      transcriptId: String(call._id),
      title: call.title,
      startedAt: call.started_at,
      live,
      partial: which === "selection" && selectedCount > 0 && selectedCount < turns.length,
    };
  };

  const onPick = (which: "selection" | "all") => (t: FeedTarget, note?: string) => {
    const excerpt = buildExcerpt(which);
    void sendExcerpt(t, excerpt, note).then(() => {
      setSentTick(t.kind === "new-doc" ? "saved to doc" : "sent. The agent replies in the side panel.");
      setTimeout(() => setSentTick(null), 3500);
    });
    if (which === "selection") clearSelection();
  };

  const isSelected = (i: number) => selLo !== null && i >= selLo && i <= (selHi as number);
  const seekTo = (ms: number) => seekCallMedia(mediaTarget, ms);

  // A recording's start or stop in the thread jumps to the picture it is
  // about (shownMomentNear snaps a press to the file's first frame).
  const momentAt = (at: number) => {
    if (!callRecs) return null;
    const ms = shownMomentNear(videoFiles, callRecs.call_started_at, at - callRecs.call_started_at);
    if (ms === null) return null;
    return {
      label: fmtClock(ms),
      onSeek: () => {
        setFollowing(true);
        seekTo(ms);
      },
    };
  };

  const onTurnClick = (i: number, e: React.MouseEvent, atMs: number) => {
    if (seekable && !e.shiftKey) {
      setFollowing(true);
      seekTo(atMs);
      return;
    }
    if (anchor === null) return setAnchor(i);
    if (e.shiftKey || anchor !== null) {
      if (i === anchor && end === null) return clearSelection();
      setEnd(i);
    }
  };

  // Playing, the line lights while its words are said; paused (or landed on
  // a moment between lines), the line last said stays lit.
  const activeIndex = seekable && mediaAt ? turnIndexAt(turns, mediaAt.ms, !mediaAt.playing) : null;
  const callRef = callRecs?.short_id ?? call.short_id ?? String(call._id);
  const ofThisCall = (r: ThreadRow) => !r.transcript_id || r.transcript_id === String(call._id);
  // Deleted: this window's own delete says so in the same frame (the store's
  // mark), and the thread's line says so for everyone else.
  const recordingDeleted =
    !hasVideo && !videoNotice && (!!callRecs?.deleted_here_at || (rows ?? []).some((r) => r.event === "record_deleted" && ofThisCall(r)));
  // The thread says this call was filmed before the recordings have answered:
  // hold the player's place, so the words do not jump down when it lands.
  const videoExpected = !recording && callRecs === undefined && (rows ?? []).some((r) => r.event === "record_on" && ofThisCall(r));

  return (
    <div ref={detailRef} className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Header: what this call was, who spoke, the ways in. */}
      <div className="shrink-0 border-b border-sol-border/20 px-6 py-4">
        <div className="flex items-center gap-2.5">
          {recording && <Mic className="h-4 w-4 shrink-0 text-sol-text-dim" />}
          <h1 className="min-w-0 line-clamp-2 text-[17px] font-medium leading-snug text-sol-text">
            {title}
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
          {/* A huddle being filmed says so in the same words a recording
              does, beside LIVE: the label is the room's, for whoever opens
              the page. */}
          {live && !recording && roomRecording && <RecordingMark size="pill" />}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-sol-text-dim">
          <span>{fmtWhen(call.started_at)}</span>
          <span>{fmtCallLength(call.started_at, call.ended_at)}</span>
          <RecordingScopePicker call={call} />
          {recording && live && <RecorderMic transcriptId={String(call._id)} />}
          {(call.participants || []).length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {(call.participants || []).map((p: any) => (
                <span
                  key={p.id}
                  className={`flex items-center gap-1 rounded-md bg-sol-bg-alt/60 px-1.5 py-0.5 font-mono text-[11px] ${speakerColor(p.id)}`}
                >
                  {firstName(p.name)}
                  {isGuestParticipant(p.id, p.name) && <GuestTag />}
                </span>
              ))}
            </span>
          )}
          {silentGuests.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5">
              {(call.participants || []).length > 0 && <span className="text-sol-text-dim" aria-hidden>·</span>}
              {silentGuests.map((g) => (
                <span
                  key={`${g.name}:${g.joined_at}`}
                  title={`${firstName(g.name)} joined from a guest link${heardAll ? " and did not speak" : ""}`}
                  className="flex items-center gap-1 rounded-md bg-sol-bg-alt/40 px-1.5 py-0.5 font-mono text-[11px] text-sol-text-dim"
                >
                  {firstName(g.name)}
                  <GuestTag />
                </span>
              ))}
            </span>
          )}
          <CallSessionChips callId={String(call._id)} sessions={call.sessions || []} />
          {sentTick && <span className="text-sol-green">{sentTick}</span>}
          <span className="flex-1" />
          <ShareControl
            label={recording ? "recording" : "call"}
            path={`/calls/${call._id}`}
            publicShare={{ kind: "call", id: String(call._id), token: call.share_token }}
            linkExtra={
              callRecs && videoRuns.some((r) => r.composite?.status === "ready") ? (
                <ShareVideoSwitch
                  call={String(call._id)}
                  shared={callRecs.video_shared}
                  linkOn={!!call.share_token}
                  canShare={callRecs.can_share_video ?? true}
                  later={callRecs.video_later ?? 0}
                  guests={(call.guests ?? []).map((g: { name: string }) => g.name)}
                />
              ) : undefined
            }
          />
          {/* Bring in somebody from outside the team while it is happening:
              the same link and panel as the stage's door group. */}
          {live && !recording && (
            <GuestInvite
              roomKey={call.room_key}
              align="end"
              trigger={({ open, toggle }) => (
                <button
                  onClick={toggle}
                  aria-expanded={open}
                  className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-sol-yellow transition-colors ${
                    open ? "bg-sol-yellow/20" : "bg-sol-yellow/10 hover:bg-sol-yellow/20"
                  }`}
                  title="Invite someone outside the team: a link they join from in a browser, no account"
                >
                  <Link2 className="h-3.5 w-3.5" /> Invite guest
                </button>
              )}
            />
          )}
          {live && !recording && !inThisRoom && (
            <button
              onClick={() => void joinCall(call.room_key, { intent: "deliberate" })}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-sol-green/15 px-3 py-1.5 text-xs font-medium text-sol-green transition-colors hover:bg-sol-green/25"
            >
              <PhoneCall className="h-3.5 w-3.5" /> Join
            </button>
          )}
          {/* Nothing to send until a word was said; on a live call the
              button appears with the first turn. */}
          {turns.length > 0 && (
            <button
              onClick={() =>
                openFeedTargetPicker({ title: "Send the whole call to…", gesture: "send", withNote: true, onPick: onPick("all") })
              }
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-sol-violet/15 px-3 py-1.5 text-xs font-medium text-sol-violet transition-colors hover:bg-sol-violet/25"
              title="Send the whole transcript to an agent session or doc"
            >
              <Sparkles className="h-3.5 w-3.5" /> Send to agent
            </button>
          )}
        </div>
      </div>

      {/* The media and the thread that follows it (components/calls/callMedia.css):
          stacked on a laptop, side by side on a wide screen when there is a
          picture to stand beside the words. */}
      <div className="call-media">
      <div className="call-media-body" data-side={!recording && (hasVideo || videoExpected) ? "" : undefined}>
      <div className="call-media-side">
      {/* The huddle's video, in step with the thread, or what to know about
          it while there is none to play: being filmed, saving, failed,
          deleted. */}
      {!recording && (hasVideo || videoNotice || recordingDeleted) && callRecs && (
        <div className="shrink-0 space-y-2 px-6 pt-4">
          {videoNotice && <CallVideoNoticeLine notice={videoNotice} quiet={!live} onDelete={() => removeRun(videoNotice.run)} />}
          {hasVideo && (
            <CallVideoPlayer
              files={videoFiles}
              callStartedAt={callRecs.call_started_at}
              handleRef={playerRef}
              onTime={media.onTime}
              missedMs={missed}
              refreshing={!!callRecs.refreshing}
              actions={({ callMs, file }) => {
                const run = videoRuns.find((r) => r.id === (file.run_id ?? file.id));
                const moment = callRefId(callRef, null, callMs);
                // Two things to copy, each named by what lands on the
                // clipboard: the reference (which a message draws as this
                // frame, and which teaches its own syntax) and a link. The
                // copy icon says the verb; the words stay short so the bar
                // keeps one line with the screen view's sound control.
                const copy = "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-sol-text";
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => void copyText(moment, "Moment copied")}
                      className={copy}
                      title="Copy this moment as a reference. Pasted in a message, it shows the call at this frame"
                    >
                      <Copy className="h-3 w-3" /> <span className="tabular-nums text-sol-text-secondary">{moment}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => copyCallFrameLink(String(call._id), callMs, file)}
                      className={copy}
                      title={file.kind === "screen" ? "Copy a link that opens the call at this moment, on this screen" : "Copy a link that opens the call at this moment"}
                    >
                      <Link2 className="h-3 w-3" /> Link
                    </button>
                    {run?.canDelete && <DeleteRecordingButton onConfirm={() => removeRun(run)} />}
                  </>
                );
              }}
            />
          )}
          {recordingDeleted && <p className="text-[12px] italic text-sol-text-dim">The recording of this call was deleted.</p>}
        </div>
      )}
      {videoExpected && (
        <div className="shrink-0 px-6 pt-4">
          <CallVideoPlaceholder />
        </div>
      )}

      {call.recording_url && (
        <div className="shrink-0 px-6 pt-4">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-sol-text-dim">
            <Mic className="h-3 w-3" /> Audio
          </div>
          <audio
            ref={audioRef}
            controls
            preload="metadata"
            src={call.recording_url}
            className="w-full max-w-lg"
            onTimeUpdate={(e) => media.onTime(e.currentTarget.currentTime * 1000, !e.currentTarget.paused)}
            onPause={(e) => media.onTime(e.currentTarget.currentTime * 1000, false)}
          />
        </div>
      )}
      </div>

      {/* The room's one thread: the words as passages (open by default here),
          the typed lines, the agents' answers, who came and went, and the
          recap. Turn selection rides on the passages' turns. Never shorter
          than about six lines, however much the video takes. */}
      <div ref={threadRef} className="call-media-thread">
      <RoomThread
        roomKey={call.room_key}
        call={call}
        rows={rows}
        liveTranscriptId={live ? id : null}
        surface="page"
        seated={inThisRoom}
        className="min-h-0 flex-1"
        focus={focus}
        selection={{
          isSelected,
          onTurnClick,
          activeIndex,
          momentAt: hasVideo && callRecs ? momentAt : undefined,
          hint:
            selectedCount === 0
              ? recording
                ? call.recording_url
                  ? "Click a line to jump there in the audio. Hold Shift and click to select lines to send."
                  : "Hold Shift and click to select lines to send."
                : hasVideo
                  ? "Click a line to see that moment in the video. Hold Shift and click to select lines to send."
                  : "Click a turn to start a selection, click another to extend, then send the excerpt to an agent."
              : null,
        }}
      />
      {/* The way back to the line being said, while the video plays and the
          reader has scrolled off to read something else. */}
      {!following && mediaAt?.playing && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            onClick={backToMoment}
            className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-sol-bg-alt px-3 py-1.5 font-mono text-[11.5px] text-sol-text-secondary shadow-xl ring-1 ring-sol-border/40 transition-colors animate-in fade-in slide-in-from-bottom-1 duration-150 hover:text-sol-text motion-reduce:animate-none"
          >
            <ArrowDownToLine className="h-3.5 w-3.5" /> Back to the moment
          </button>
        </div>
      )}
      </div>
      </div>
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
              onClick={() =>
                copyCallLink(
                  String(call._id),
                  turnsAnchor(turns.slice(selLo!, (selHi as number) + 1)),
                  // With video the link also waits at the first line's moment.
                  hasVideo ? turns[selLo!]?.t0 : undefined,
                )
              }
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-sol-text-muted transition-colors hover:bg-sol-bg/60 hover:text-sol-text"
              title={
                hasVideo
                  ? "Copy a link that opens the call on these turns, the video waiting at the first"
                  : "Copy a link that opens the call on these turns"
              }
            >
              <Link2 className="h-3 w-3" /> Copy link
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
        Recording. Open the transcript
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
      title="Records what your microphone hears: the room, and anything playing through your speakers"
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
  // A link built from a call's short id (`/calls/cl-42?turns=15-25`) lands
  // on the call's page under its full id, the anchor kept.
  const shortRef = selectedId && /^cl-\d+$/i.test(selectedId) ? selectedId : null;
  const byShort = useQueryNoThrow(api.transcripts.webGetCallRef, shortRef ? { ref: shortRef } : "skip").data as
    | { _id: string }
    | null
    | undefined;
  const router = useRouter();
  const search = useSearchParams();
  useWatchEffect(() => {
    if (byShort?._id) router.replace(`/calls/${byShort._id}${search?.toString() ? `?${search}` : ""}`);
  }, [byShort?._id]);
  const callsOn = useTeamFeature("calls");
  // Always asked, whatever the ACTIVE team's calls feature says: recordings
  // are personal — they land here from every team and from none — and the
  // server already answers with exactly what this viewer may read (a huddle
  // only under its own team's feature gate, a recording under its creator's
  // ownership). Gating the query on the active team made someone's private
  // recordings vanish when they switched teams.
  // Local first: the history paints from the cached list on the first frame
  // and the live answer only keeps it current. A skeleton is honest only
  // while nothing is cached and nothing has answered.
  const { calls, ready: callsReady, error: callsError, retry: retryCalls } = useCallList(100);
  const { liveCalls, pastCalls, transcribedRoomKeys } = useMemo(() => {
    const rows = calls;
    const live = rows.filter(isCallLive);
    return {
      liveCalls: live,
      pastCalls: rows.filter((r) => !isCallLive(r)),
      transcribedRoomKeys: new Set<string>(live.map((r) => r.room_key).filter(Boolean)),
    };
  }, [calls]);

  return (
    <AuthGuard>
      <DashboardLayout>
        {/* Master and detail side by side from md up (the breakpoint the
            sidebar folds at). Below it one at a time: the list until a call
            is picked, then the call alone with a way back, so a frame link
            opened on a phone lands on a page the width of the phone. */}
        <div className="flex h-full min-h-0">
          <div className={`${selectedId ? "hidden md:flex" : "flex"} w-full shrink-0 flex-col border-r border-sol-border/20 md:w-72`}>
            <div className="shrink-0 border-b border-sol-border/20 px-4 py-3">
              <h2 className="text-sm font-medium text-sol-text">Calls</h2>
              <p className="mt-0.5 text-[11px] text-sol-text-dim">
                Transcribed huddles and recordings, also via{" "}
                <code className="text-sol-cyan">cast calls</code>
              </p>
              <RecordMeetingButton />
              <p className="mt-1.5 text-[10.5px] leading-snug text-sol-text-dim/80">
                Records from your microphone. A recording starts private to
                you, whatever team is active. Share it into a team from its
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
              {calls.length === 0 && callsError ? (
                <div className="p-4 text-[12px] leading-relaxed text-sol-text-dim">
                  Your calls could not be loaded.{" "}
                  <button type="button" onClick={retryCalls} className="text-sol-cyan hover:underline">
                    Try again
                  </button>
                </div>
              ) : calls.length === 0 && !callsReady ? (
                <div className="p-4 text-[12px] text-sol-text-dim">Loading…</div>
              ) : calls.length === 0 ? (
                <div className="p-4 text-[12px] leading-relaxed text-sol-text-dim">
                  Nothing here yet. Start a huddle and add an agent, or switch
                  transcription on in the thread. Or record the meeting in the
                  room around you. Either lands here with a live transcript
                  and, when it ends, a summary and action items.
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
          <div className={`${selectedId ? "flex" : "hidden md:flex"} relative min-w-0 flex-1 flex-col`}>
            {selectedId && (
              // Back to the list, without the moment or the anchor: the
              // list has no place in a call to keep.
              <Link
                href="/calls"
                className="flex shrink-0 items-center gap-1 border-b border-sol-border/20 px-3 py-2 text-[12px] text-sol-text-muted transition-colors hover:text-sol-text md:hidden"
              >
                <ChevronLeft className="h-4 w-4" /> Calls
              </Link>
            )}
            <div className="relative min-h-0 flex-1">
              {selectedId && !shortRef ? (
                <CallDetail id={selectedId} preview={calls.find((r) => String(r._id) === selectedId)} />
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
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
