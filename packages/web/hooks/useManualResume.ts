// The /threads pane's resume: the stall's Retry/Resume and the resume banner
// send convCommand("resumeSession"), and a resume no daemon answers within 45s
// escalates once to a forced restart. Both are daemon commands only the
// session's runner or second-party owner may send (commandsSession), so a
// viewer without that right sends nothing (ct-91098 / eg-2899).
import { useCallback, useRef, useState } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { requestSessionRestart } from "../lib/sessionCommands";

export type ManualResumeState = "idle" | "resuming" | "sent" | "failed";

export function useManualResume(sessionId: string, isIdle: boolean, canCommand: boolean) {
  const convCommand = useInboxStore((s) => s.convCommand);
  const [resumeState, setResumeState] = useState<ManualResumeState>("idle");
  const forceRestartAttemptedRef = useRef(false);
  const [_trackedSessionId, _setTrackedSessionId] = useState(sessionId);
  if (_trackedSessionId !== sessionId) {
    _setTrackedSessionId(sessionId);
    setResumeState("idle");
    forceRestartAttemptedRef.current = false;
  }

  useWatchEffect(() => {
    if (!isIdle && (resumeState === "sent" || resumeState === "resuming")) {
      setResumeState("idle");
      forceRestartAttemptedRef.current = false;
    }
  }, [isIdle, resumeState]);

  useWatchEffect(() => {
    if (resumeState !== "sent" || !canCommand) return;
    const timeout = setTimeout(async () => {
      if (!forceRestartAttemptedRef.current && isConvexId(sessionId)) {
        forceRestartAttemptedRef.current = true;
        try {
          await requestSessionRestart(sessionId);
          setResumeState("sent");
        } catch (err) {
          // The outbox owns delivery now. Stay in the pending recovery state;
          // a later response-dependent redirect cannot be fabricated here.
          if (isParkedDispatchError(err)) return;
          setResumeState("failed");
        }
      } else {
        setResumeState("failed");
      }
    }, 45_000);
    return () => clearTimeout(timeout);
  }, [resumeState, sessionId, canCommand]);

  // `leave_out` answers a cloud placement whose context was over the cap.
  const handleManualResume = useCallback((extra?: { leave_out?: string[] }) => {
    if (!canCommand) return;
    setResumeState("resuming");
    convCommand(sessionId, "resumeSession", extra?.leave_out ? { leave_out: extra.leave_out } : undefined)
      .then(() => setResumeState("sent"))
      .catch((err) => {
        if (isParkedDispatchError(err)) {
          setResumeState("sent");
          return;
        }
        setResumeState("failed");
      });
  }, [sessionId, convCommand, canCommand]);

  return { resumeState, handleManualResume };
}
