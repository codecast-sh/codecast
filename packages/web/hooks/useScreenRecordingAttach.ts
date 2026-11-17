// A screen recording attached in the web composer: a video file dropped or
// pasted in (a Cmd-Shift-5 recording on a Mac, a phone's file AirDropped
// over). The same path as the phone's (mobile lib/screenRecordingSend): the
// attach opens the recording call on the server and starts the upload at
// once, and the send is an ordinary message carrying the recording's tag
// (shared/contracts/screenRecording) with the typed words.
import { useCallback, useRef, useState } from "react";
import { useConvex } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { formatScreenRecordingMessage } from "@codecast/shared/contracts";

export type AttachedRecording = {
  file: File;
  durationMs: number;
  /** Named by the server: the send can carry it. */
  begun: { transcriptId: string; call: string } | null;
  /** The bytes are in the bucket. */
  uploaded: boolean;
};

/** The video's length and picture size, read by the browser itself. */
function videoFacts(file: File): Promise<{ durationMs: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    const done = (facts: { durationMs: number; width: number; height: number }) => {
      URL.revokeObjectURL(url);
      resolve(facts);
    };
    v.onloadedmetadata = () => done({ durationMs: Math.round((Number.isFinite(v.duration) ? v.duration : 0) * 1000), width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => done({ durationMs: 0, width: 0, height: 0 });
    v.src = url;
  });
}

export function isRecordingFile(file: File): boolean {
  return file.type === "video/mp4" || file.type === "video/quicktime" || /\.(mov|mp4|m4v)$/i.test(file.name);
}

export function useScreenRecordingAttach(conversationId: string, enabled: boolean) {
  const convex = useConvex();
  const [recording, setRecording] = useState<AttachedRecording | null>(null);
  const current = useRef<AttachedRecording | null>(null);
  current.current = recording;

  const discard = useCallback((rec: AttachedRecording | null) => {
    if (!rec?.begun) return;
    void convex.mutation(api.screenRecordings.discard, { transcript_id: rec.begun.transcriptId as Id<"transcripts"> }).catch(() => {});
  }, [convex]);

  const attach = useCallback(async (file: File) => {
    if (!enabled) {
      toast.error("A recording can be sent to a session once it has started");
      return;
    }
    // One recording per turn: a second replaces the first, which is taken back.
    discard(current.current);
    const facts = await videoFacts(file);
    const mine = (r: AttachedRecording | null) => r?.file === file;
    setRecording({ file, durationMs: facts.durationMs, begun: null, uploaded: false });
    let begun: { transcript_id: Id<"transcripts">; call: string; upload_url: string };
    try {
      begun = await convex.mutation(api.screenRecordings.begin, {
        conversation_id: conversationId,
        mime: file.type || "video/mp4",
        duration_ms: facts.durationMs,
        ...(facts.width ? { width: facts.width, height: facts.height } : {}),
      });
    } catch (err) {
      toast.error(`Could not attach the recording: ${err instanceof Error ? err.message : String(err)}`);
      setRecording((r) => (mine(r) ? null : r));
      return;
    }
    const named = { transcriptId: String(begun.transcript_id), call: begun.call };
    setRecording((r) => (mine(r) ? { ...r!, begun: named } : r));
    try {
      // Stored as MP4 whatever the file says: browsers refuse `video/quicktime`.
      const res = await fetch(begun.upload_url, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: file });
      if (!res.ok) throw new Error(`upload ${res.status}`);
      await convex.mutation(api.screenRecordings.uploaded, { transcript_id: begun.transcript_id });
      setRecording((r) => (mine(r) ? { ...r!, uploaded: true } : r));
    } catch (err) {
      toast.error(`Recording upload failed: ${err instanceof Error ? err.message : String(err)}`);
      setRecording((r) => (mine(r) ? null : r));
    }
  }, [convex, conversationId, enabled, discard]);

  /** The person took it off the turn. */
  const remove = useCallback(() => {
    discard(current.current);
    setRecording(null);
  }, [discard]);

  /** The turn's text with the recording, which the send takes: the composer
   *  holds no recording after it. Unchanged when none is named yet. */
  const take = useCallback((text: string): string => {
    const rec = current.current;
    if (!rec?.begun) return text;
    setRecording(null);
    return formatScreenRecordingMessage({ call: rec.begun.call, transcriptId: rec.begun.transcriptId, durationMs: rec.durationMs }, text);
  }, []);

  return { recording, attach, remove, take, ready: !!recording?.begun };
}
