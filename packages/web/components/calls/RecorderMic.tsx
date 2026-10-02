"use client";

// The microphone a running recording hears, on the recording's own page: how
// loud it is hearing the room, and which microphone that is, switchable
// without stopping. The pill proves the recording is alive from anywhere; this
// is where somebody who suspects the wrong mic goes to fix it.
import { Mic } from "lucide-react";
import { MicSelect } from "./DeviceRows";
import { useRecorderLevelVar, useRecorderStatus } from "../../hooks/useRecorder";
import "./recorder.css";

/** Renders only while THIS transcript is the recording running here. */
export function RecorderMic({ transcriptId }: { transcriptId: string }) {
  const status = useRecorderStatus();
  const running = status.phase === "recording" && status.transcriptId === transcriptId;
  const levelRef = useRecorderLevelVar<HTMLSpanElement>(running);
  if (!running) return null;
  return (
    <span className="rec-mic">
      <Mic className="h-3 w-3 shrink-0" />
      <MicSelect className="rec-mic-select" />
      <span ref={levelRef} className="rec-pill-level rec-mic-level" aria-hidden="true">
        {[0.45, 0.8, 1, 0.7, 0.5, 0.85, 0.6].map((b, i) => (
          <i key={i} style={{ ["--b" as string]: b }} />
        ))}
      </span>
    </span>
  );
}
