import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, MicOff, MonitorPlay } from "lucide-react";
import { callAnchorHref, formatCallTime, type ParsedScreenRecording } from "@codecast/shared/contracts";
import { toVideoFile, useCallRecordings } from "../../hooks/useRoomRecording";
import { useCallDetail } from "../../hooks/useSyncCalls";
import { CALL_VIDEO_LOADING, playableFiles } from "../../lib/calls/callVideo";
import { useWatchEffect } from "../../hooks/useWatchEffect";

// A screen recording the person sent to the session (shared/contracts/
// screenRecording): the video they made beside what they said while making
// it, each line at its time. A line is a seek, and the line being said is
// lit as it plays, so "this button" reads next to the button.
//
// Both halves come from the recording call in the store (the call's detail
// for the words, its files for the video), never from the message text: a
// message sent a moment ago fills in as the server reads the words, and the
// agent's expanded copy and the person's own message draw the same card.

type Line = { t0: number; t1: number; text: string };

export function ScreenRecordingCard({ recording }: { recording: ParsedScreenRecording }) {
  const id = recording.transcriptId ?? undefined;
  const call = useCallDetail(id);
  const recs = useCallRecordings(id ?? null);
  const file = useMemo(() => playableFiles((recs?.recordings ?? []).map(toVideoFile))[0] ?? null, [recs]);
  const lines: Line[] = useMemo(() => {
    if (call?.segments?.length) return call.segments.map((s: any) => ({ t0: s.t0, t1: s.t1 ?? s.t0, text: s.text }));
    // Before the store has the call, the agent's copy already carries the words.
    return recording.lines.map((l, i, all) => ({ t0: l.atMs, t1: all[i + 1]?.atMs ?? recording.durationMs, text: l.text }));
  }, [call?.segments, recording.lines, recording.durationMs]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);
  const active = nowMs === null ? -1 : lines.findIndex((l, i) => nowMs >= l.t0 && nowMs < (lines[i + 1]?.t0 ?? Infinity));
  const listRef = useRef<HTMLOListElement>(null);
  useWatchEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-line="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const seek = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = ms / 1000;
    void v.play().catch(() => {});
  };

  const durationMs = file?.duration_ms ?? (call ? Math.max(0, (call.ended_at ?? call.started_at) - call.started_at) : recording.durationMs);
  // Not in the store yet reads as on its way, never as "no words".
  const pending = !!id && !recording.lines.length && (call === undefined || call?.transcribe_status === "pending");
  const noAudio = !!call?.screen?.no_audio;
  const failed = call?.transcribe_status === "failed" && !noAudio;
  const portrait = (call?.screen?.height ?? 16) >= (call?.screen?.width ?? 9);

  return (
    <div className="w-[min(100%,720px)] overflow-hidden rounded-lg bg-sol-bg-alt ring-1 ring-sol-border/40 modern:rounded-card" data-screen-recording={recording.call}>
      <div className="flex items-center gap-2 border-b border-sol-border/30 px-3 py-1.5 text-meta">
        <MonitorPlay className="h-3.5 w-3.5 shrink-0 text-sol-cyan" />
        <span className="font-medium text-sol-text">Screen recording</span>
        <span className="tabular-nums text-sol-text-dim">{formatCallTime(durationMs)}</span>
        {pending && <span className="text-sol-yellow">transcribing</span>}
        {noAudio && (
          <span className="flex items-center gap-1 text-sol-orange" title="The video has no sound track: the microphone was off while recording">
            <MicOff className="h-3 w-3" /> no sound
          </span>
        )}
        {failed && <span className="text-sol-text-dim">no words heard</span>}
        <Link href={callAnchorHref(recording.call)} className="ml-auto flex items-center gap-0.5 text-sol-text-dim hover:text-sol-text" title="Open the recording's page">
          {recording.call} <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
      <div className={portrait ? "flex flex-col sm:flex-row" : "flex flex-col"}>
        <div className={`relative shrink-0 bg-black ${portrait ? "sm:w-[220px]" : ""}`}>
          {file?.url ? (
            <video
              ref={videoRef}
              src={file.url}
              controls
              playsInline
              preload="metadata"
              className={portrait ? "mx-auto block max-h-[440px] w-full object-contain" : "block max-h-[420px] w-full object-contain"}
              onTimeUpdate={(e) => setNowMs(e.currentTarget.currentTime * 1000)}
              onSeeked={(e) => setNowMs(e.currentTarget.currentTime * 1000)}
            />
          ) : (
            <div className={portrait ? "aspect-[9/19] max-h-[440px] w-full" : "aspect-video w-full"}>
              {id && recs === null ? (
                <div className="flex h-full items-center justify-center px-4 text-center text-meta text-sol-text-dim">Video not available to you</div>
              ) : (
                <div className={CALL_VIDEO_LOADING} />
              )}
            </div>
          )}
        </div>
        <ol ref={listRef} className={`min-w-0 flex-1 overflow-y-auto py-1 ${portrait ? "sm:max-h-[440px]" : "max-h-[240px]"}`}>
          {lines.length === 0 && (
            <li className="px-3 py-2 text-meta text-sol-text-dim">
              {pending ? "Reading what was said…" : noAudio ? "Recorded without the microphone, so there are no words." : "No words in this recording."}
            </li>
          )}
          {lines.map((l, i) => (
            <li key={i} data-line={i}>
              <button
                type="button"
                onClick={() => seek(l.t0)}
                className={`flex w-full gap-2.5 px-3 py-1 text-left text-sm transition-colors hover:bg-sol-text/[0.05] ${i === active ? "bg-sol-cyan/10" : ""}`}
              >
                <span className={`w-9 shrink-0 pt-px text-right font-mono text-meta tabular-nums ${i === active ? "text-sol-cyan" : "text-sol-text-dim"}`}>{formatCallTime(l.t0)}</span>
                <span className="min-w-0 text-sol-text">{l.text}</span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
