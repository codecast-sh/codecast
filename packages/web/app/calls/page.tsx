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
import { TeamFeatureOff } from "../../components/TeamFeatureOff";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { toast } from "sonner";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { getRoom, joinCall } from "../../lib/calls/callManager";
import { useInboxStore } from "../../store/inboxStore";
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
import {
  Phone,
  PhoneCall,
  Radio,
  ListChecks,
  AlignLeft,
  MessageSquare,
  Send,
  Sparkles,
  X,
} from "lucide-react";

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

function CallListRow({ call, selected }: { call: any; selected: boolean }) {
  const live = call.status === "live";
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
        ) : (
          <Phone className="h-3 w-3 shrink-0 text-sol-text-dim" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-sol-text">
          {call.title || "Untitled huddle"}
        </span>
        <span className={`shrink-0 text-[11px] ${live ? "text-sol-green" : "text-sol-text-dim"}`}>
          {fmtDuration(call.started_at, call.ended_at)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-4">
        <span className="shrink-0 text-[11px] text-sol-text-dim">{fmtWhen(call.started_at)}</span>
        {people.length > 0 ? (
          <span className="min-w-0 truncate text-[11px]">
            {people.map((p: any, i: number) => (
              <span key={p.id} className={speakerColor(p.id)}>
                {firstName(p.name)}
                {i < people.length - 1 ? ", " : ""}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-[11px] italic text-sol-text-dim">no one spoke yet</span>
        )}
      </div>
    </Link>
  );
}

// Consecutive segments from one speaker, the unit selection works on.
type Turn = {
  index: number;
  speaker_id: string;
  speaker_name: string;
  t0: number;
  segments: any[];
};

function groupTurns(segments: any[]): Turn[] {
  const turns: Turn[] = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker_id === s.speaker_id) last.segments.push(s);
    else
      turns.push({
        index: turns.length,
        speaker_id: s.speaker_id,
        speaker_name: s.speaker_name,
        t0: s.t0,
        segments: [s],
      });
  }
  return turns;
}

function CallDetail({ id }: { id: string }) {
  // Plain useQuery: a live call's transcript streams into this subscription
  // in real time — segments appear as people speak.
  const call = useQuery(api.transcripts.webGetCall, { transcript_id: id as any });
  const myCall = useInboxStore((s) => s.call);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Selection resets when the viewer moves to another call.
  useEffect(() => clearSelection(), [id]);

  const live = isLive;

  // Live transcripts follow the tail while the reader is near the bottom.
  const scrollRef = useRef<HTMLDivElement>(null);
  const segCount = call?.segments?.length ?? 0;
  useEffect(() => {
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
            <h1 className="min-w-0 truncate text-[17px] font-medium text-sol-text">
              {call.title || "Untitled huddle"}
            </h1>
            {live && (
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-sol-green">
                <Radio className="h-3.5 w-3.5" /> LIVE
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-sol-text-dim">
            <span>{fmtWhen(call.started_at)}</span>
            <span>{fmtDuration(call.started_at, call.ended_at)}</span>
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
            {live && !inThisRoom && (
              <button
                onClick={() => void joinCall(call.room_key)}
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

          {turns.length === 0 ? (
            <div className="text-sm text-sol-text-dim">
              {live ? "Listening — the transcript appears as people speak." : "Nothing was transcribed."}
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
                {turns.map((t) => (
                  <div
                    key={t.index}
                    role="button"
                    tabIndex={0}
                    aria-pressed={isSelected(t.index)}
                    aria-label={`Turn by ${firstName(t.speaker_name)} at ${fmtClock(t.t0)}`}
                    onClick={(e) => onTurnClick(t.index, e)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onTurnClick(t.index, e as any);
                      }
                    }}
                    className={`-mx-2 cursor-pointer rounded-md px-2 py-1 transition-colors ${
                      isSelected(t.index)
                        ? "bg-sol-violet/10 ring-1 ring-inset ring-sol-violet/40"
                        : "hover:bg-sol-bg-alt/40"
                    }`}
                  >
                    <div className={`text-[11px] font-medium ${speakerColor(t.speaker_id)}`}>
                      {firstName(t.speaker_name)}
                      <span className="ml-2 font-normal text-sol-text-dim">{fmtClock(t.t0)}</span>
                    </div>
                    {t.segments.map((s: any) => (
                      <p key={s.seq} className="text-[13px] leading-relaxed text-sol-text">
                        {s.text}
                      </p>
                    ))}
                  </div>
                ))}
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

export default function CallsPage() {
  const params = useParams() as { id?: string };
  const selectedId = params?.id ?? null;
  const callsOn = useTeamFeature("calls");
  const calls = useQueryNoThrow(api.transcripts.webListCalls, callsOn ? { limit: 100 } : "skip").data as
    | any[]
    | undefined;
  const { liveCalls, pastCalls } = useMemo(() => {
    const rows = calls ?? [];
    return {
      liveCalls: rows.filter((r) => r.status === "live"),
      pastCalls: rows.filter((r) => r.status !== "live"),
    };
  }, [calls]);

  if (!callsOn) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <TeamFeatureOff feature="calls" />
        </DashboardLayout>
      </AuthGuard>
    );
  }

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="flex h-full min-h-0">
          <div className="flex w-72 shrink-0 flex-col border-r border-sol-border/20">
            <div className="shrink-0 border-b border-sol-border/20 px-4 py-3">
              <h2 className="text-sm font-medium text-sol-text">Calls</h2>
              <p className="mt-0.5 text-[11px] text-sol-text-dim">
                Transcribed huddles — also via <code className="text-sol-cyan">cast calls</code>
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {calls === undefined ? (
                <div className="p-4 text-[12px] text-sol-text-dim">Loading…</div>
              ) : calls.length === 0 ? (
                <div className="p-4 text-[12px] leading-relaxed text-sol-text-dim">
                  No calls yet. Start a huddle and toggle Transcribe — the call
                  lands here with a live transcript and, when it ends, a summary.
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
