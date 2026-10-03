"use client";
// /share/call/<token>: a call's record (huddle or recording) as a stranger
// holding its link reads it: the recap, the action items, the audio when
// there is any, the room's video when whoever shared the link chose to
// include it, and the words, in the same turns the calls page draws. With
// media, a line clicked plays from there and the line being said lights, as on
// the calls page. A link to a place in the call (?turns=, ?part=, ?t=,
// @codecast/shared callLinks) lands there, marked, the way the call page does.
import { useMemo, useRef, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { Mic } from "lucide-react";
// react-router directly, not the next/navigation shim: the shim carries the
// app store, and this page boots without it (standaloneBootGraph guard).
import { useSearchParams } from "react-router";
import { api } from "@codecast/convex/convex/_generated/api";
import { callAnchorKey, parseCallAnchor, parseCallMomentParam, type CallAnchor } from "@codecast/shared/contracts";
import { TranscriptTurnList } from "../../../../components/calls/TranscriptTurns";
import { groupTurns, oneSegmentTurns } from "../../../../components/calls/transcriptTurnModel";
import { fmtCallLength } from "../../../../components/calls/speakers";
import { Bullets, Callout, Pill, Prose, Section, ShareHead, SharedObjectPage } from "../../SharedObjectPage";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { CallVideoPlayer, type CallVideoHandle } from "../../../../components/calls/CallVideoPlayer";
import { turnIndexAt, type CallVideoFile } from "../../../../lib/calls/callVideo";
import { useMediaMoment } from "../../../../hooks/useMediaMoment";

type SharedCall = NonNullable<FunctionReturnType<typeof api.publicShare.getSharedCall>>;

const MARK = "ring-2 ring-sol-violet/50 rounded-[14px]";

export default function SharedCallPage() {
  const [params] = useSearchParams();
  const anchor = parseCallAnchor(params);
  const momentMs = parseCallMomentParam(params);
  const anchorKey = anchor ? callAnchorKey(anchor) : null;
  // Scroll the anchored place into view once it has rendered.
  useWatchEffect(() => {
    if (!anchorKey) return;
    const timer = setInterval(() => {
      // Turns mark their list with the first anchored turn; the recap parts
      // carry the key themselves.
      const host = document.querySelector<HTMLElement>(`[data-call-anchor="${anchorKey}"]`);
      const first = host?.dataset.firstTurn;
      const el = first ? document.querySelector(`[data-turn="${first}"]`) : host;
      if (!el) return;
      clearInterval(timer);
      el.scrollIntoView({ block: "center" });
    }, 100);
    return () => clearInterval(timer);
  }, [anchorKey]);
  return (
    <SharedObjectPage<SharedCall> kind="call" query={api.publicShare.getSharedCall} noun="call">
      {(call) => <SharedCallBody call={call} anchor={anchor} anchorKey={anchorKey} momentMs={momentMs} />}
    </SharedObjectPage>
  );
}

function SharedCallBody({
  call,
  anchor,
  anchorKey,
  momentMs,
}: {
  call: SharedCall;
  anchor: CallAnchor | null;
  anchorKey: string | null;
  momentMs: number | null;
}) {
  // A recording has one microphone: line by line, no speaker names.
  const turns = useMemo(() => (call.recording ? oneSegmentTurns(call.segments) : groupTurns(call.segments)), [call.recording, call.segments]);
  const inAnchor = (i: number) =>
    anchor?.kind === "turns" && turns[i]?.segments.some((sg) => sg.seq >= anchor.from_seq && sg.seq <= anchor.to_seq);
  const firstAnchored = turns.findIndex((_, i) => inAnchor(i));

  // The media the words follow: the room's video when the link includes it,
  // else a recording's audio. Each shared video is a finished room recording
  // with its own time 0 (the redirect URL re-checks the link on every load).
  const files = useMemo<CallVideoFile[]>(
    () =>
      (call.videos ?? []).map((v) => ({
        id: v.id,
        kind: "composite" as const,
        status: "ready" as const,
        started_at: v.started_at,
        duration_ms: v.duration_ms,
        url: v.url,
      })),
    [call],
  );
  const playerRef = useRef<CallVideoHandle | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Renders when the lit line (or play and pause) moves, not on every tick.
  const media = useMediaMoment(turns);
  const mediaAt = media.at;
  const hasMedia = files.length > 0 || !!call.recording_url;
  // A line clicked where no video shows says so where the video is (the
  // player's own line, as on the call page), until the next seek.
  const [missed, setMissed] = useState<number | null>(null);
  const seekTo = (ms: number) => {
    if (files.length > 0) return setMissed(playerRef.current?.seek(ms) === false ? ms : null);
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, ms / 1000);
    void el.play().catch(() => {});
  };
  const activeIndex = hasMedia && mediaAt ? turnIndexAt(turns, mediaAt.ms, !mediaAt.playing) : null;

  // A link to a moment waits there, its line lit and in view. A call filmed
  // with transcription off has video and no lines, and still lands, on the
  // picture alone.
  const landed = useRef(false);
  useWatchEffect(() => {
    if (momentMs === null || landed.current || (turns.length === 0 && files.length === 0)) return;
    landed.current = true;
    if (files.length > 0) setMissed(playerRef.current?.seek(momentMs, { play: false }) === false ? momentMs : null);
    else if (audioRef.current) audioRef.current.currentTime = momentMs / 1000;
    media.set({ ms: momentMs, playing: false });
    const i = turnIndexAt(turns, momentMs, true);
    if (i !== null) setTimeout(() => document.querySelector(`[data-turn="${turns[i].index}"]`)?.scrollIntoView({ block: "center" }), 80);
  }, [momentMs, turns.length, files.length]);

  return (
    <>
      <ShareHead
        badges={
          <>
            <Pill tone={call.recording ? "red" : "green"}>
              {call.recording ? <Mic size={11} /> : null}
              {call.recording ? "Recording" : "Huddle"}
            </Pill>
            <Pill quiet>{fmtCallLength(call.started_at, call.ended_at)}</Pill>
          </>
        }
        title={call.title || (call.recording ? "Untitled recording" : "Untitled huddle")}
        at={call.started_at}
        meta={
          // The voices on the record, a guest among them already marked
          // "(guest)" in the name. A guest who only listened is not named on
          // a page anybody with the link can open.
          !call.recording && call.participants.length > 0 ? <span>with {call.participants.map((p) => p.name).join(", ")}</span> : null
        }
      />
      {call.summary && (
        <div data-call-anchor="summary" className={anchor?.kind === "summary" ? MARK : ""}>
          <Callout label="Summary">
            <Prose content={call.summary} compact />
          </Callout>
        </div>
      )}
      {call.action_items.length > 0 && (
        <Section title="Action items" count={call.action_items.length}>
          <Bullets
            tone="cyan"
            items={call.action_items.map((a, i) => (
              <span key={i} data-call-anchor={`action-${i}`} className={anchor?.kind === "action" && anchor.index === i ? `${MARK} px-1` : ""}>
                {a}
              </span>
            ))}
          />
        </Section>
      )}
      {files.length > 0 && (
        <div style={{ marginBottom: 36 }}>
          <CallVideoPlayer
            files={files}
            callStartedAt={call.started_at}
            handleRef={playerRef}
            onTime={media.onTime}
            missedMs={missed}
          />
        </div>
      )}
      {call.recording_url && files.length === 0 && (
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={call.recording_url}
          style={{ width: "100%", marginBottom: 36 }}
          onTimeUpdate={(e) => media.onTime(e.currentTarget.currentTime * 1000, !e.currentTarget.paused)}
          onPause={(e) => media.onTime(e.currentTarget.currentTime * 1000, false)}
        />
      )}
      {turns.length > 0 && (
        <Section title="Transcript" count={turns.length}>
          <div
            className="space-y-2"
            data-call-anchor={firstAnchored >= 0 ? anchorKey ?? undefined : undefined}
            data-first-turn={firstAnchored >= 0 ? turns[firstAnchored].index : undefined}
          >
            <TranscriptTurnList
              turns={turns}
              compact={call.recording}
              isSelected={inAnchor}
              activeIndex={activeIndex}
              onTurnClick={hasMedia ? (i) => seekTo(turns[i]?.t0 ?? 0) : undefined}
            />
          </div>
        </Section>
      )}
    </>
  );
}
