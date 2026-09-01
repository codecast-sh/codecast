"use client";

// The one surface that says a recording is running.
//
// Mounted app-wide and portalled to the body, because the person recording a
// meeting is by definition doing something else — reading a doc, taking notes,
// looking at the person talking. It carries the four things that matter and
// nothing more: that it IS recording, for how long, that the microphone is
// hearing words, and how to stop.
//
// Clicking it opens the transcript, which is the calls page's own detail view
// streaming live. There is no second transcript surface to keep in step.
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Maximize2, Square } from "lucide-react";
import { stopRecording } from "../../lib/calls/recorder";
import { useRecorderLevelVar, useRecorderStatus } from "../../hooks/useRecorder";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { fmtClock } from "./speakers";
import "./recorder.css";

export function RecordingPill() {
  const status = useRecorderStatus();
  const router = useRouter();
  const running = status.phase === "recording";
  const stopping = status.phase === "stopping";
  // The clock is time passing, not data arriving — its own second-by-second
  // timer, shared with every other one-second clock in the app.
  const now = useCoarseNow(1000);
  const levelRef = useRecorderLevelVar<HTMLSpanElement>(running);

  if (!running && !stopping) return null;

  const last = status.tail[status.tail.length - 1]?.text ?? "";

  return createPortal(
    <div className="rec-pill-host">
      <div className="rec-pill">
        <span className="rec-pill-dot" aria-hidden="true" />
        <span ref={levelRef} className="rec-pill-level" aria-hidden="true">
          {[0.55, 1, 0.75, 0.4].map((b, i) => (
            <i key={i} style={{ ["--b" as string]: b }} />
          ))}
        </span>
        <div className="rec-pill-body">
          <div className="rec-pill-head">
            <span className="rec-pill-clock">
              {fmtClock(status.startedAt ? now - status.startedAt : 0)}
            </span>
            {/* Where the sound comes from, in the words the feature actually
                delivers: the microphone always, and on the desktop the
                computer's own audio when the shell could open that feed. */}
            <span className="rec-pill-what">
              {stopping
                ? "finishing"
                : status.systemAudio
                  ? "recording the room + computer audio"
                  : "recording the room"}
            </span>
          </div>
          {last ? (
            <div className="rec-pill-tail" title={last}>
              {last}
            </div>
          ) : (
            <div className="rec-pill-quiet">
              {status.error ?? "listening — words appear as people speak"}
            </div>
          )}
        </div>
        {status.transcriptId && (
          <button
            type="button"
            className="rec-pill-open"
            title="Open the live transcript"
            aria-label="Open the live transcript"
            onClick={() => router.push(`/calls/${status.transcriptId}`)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          className="rec-pill-stop"
          disabled={stopping}
          onClick={() => void stopRecording()}
        >
          <Square className="h-3 w-3 fill-current" />
          {stopping ? "Saving" : "Stop"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
