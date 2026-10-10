"use client";

/**
 * The daemon's `session_error`, rendered the same way on every conversation
 * surface (inbox queue, side panel, floating window). ONE definition so the
 * hosts can't drift apart — they only differ in how they resume.
 *
 * In normal flow rather than an absolute overlay, so it can't be clipped behind
 * the conversation header's higher-z elements. The text wraps instead of
 * truncating to one line: the errors that matter most ("No local checkout for
 * <remote> (recorded path X doesn't exist here). Clone it first.") put the
 * instruction at the END of the sentence, which truncation ate.
 */

import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useDevices } from "./DeviceBadge";
import { deviceSeesPath } from "../lib/machinePicker";
import { classifyApiErrorBanner, SAFETY_BLOCK_HINT } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";

const mib = (bytes: number) => `${Math.ceil(bytes / 1048576)} MiB`;

/**
 * The transient resume-lifecycle banners (resuming, reconstituting, timed
 * out), shared by the same hosts as SessionErrorBanner. In normal flow
 * for the same reason: an absolute overlay at the top of the conversation area
 * stretches across the diff panel and its backdrop blur obscures the diff
 * view's header.
 */
export function SessionResumeBanner({
  resumeState,
  onResume,
}: {
  resumeState: "idle" | "resuming" | "sent" | "reconstituting" | "failed";
  onResume: () => void;
}) {
  if (resumeState === "resuming" || resumeState === "sent" || resumeState === "reconstituting") {
    return (
      <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-sol-orange/90 text-sol-bg text-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-sol-bg animate-pulse" />
        {resumeState === "reconstituting" ? "Reconstituting session from database..." : "Resuming session..."}
      </div>
    );
  }
  if (resumeState === "failed") {
    return (
      <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs">
        <span className="w-1.5 h-1.5 rounded-full bg-sol-bg" />
        Resume timed out
        <button onClick={onResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors">
          Retry
        </button>
      </div>
    );
  }
  return null;
}

export function SessionErrorBanner({
  error,
  sessionId,
  projectPath,
  ownerDeviceId,
  onResume,
}: {
  error: string;
  sessionId?: string;
  projectPath?: string | null;
  ownerDeviceId?: string | null;
  /** `leave_out` is the answer to a cloud placement over the context cap. */
  onResume?: (extra?: { leave_out?: string[] }) => void;
}) {
  const { devices } = useDevices();
  // A cloud placement over the context cap is a question, not a dead end:
  // the row names what would have to stay behind for the context to fit.
  const tooLarge = useInboxStore((s) => (sessionId ? s.sessions[sessionId]?.cloud_context_too_large : null));
  // Keyed by the error text, not a bare boolean: dismissing "no local checkout"
  // must not also swallow whatever the session fails with next.
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  if (!error || dismissedError === error) return null;
  const safety = classifyApiErrorBanner(error) === "safety";

  // Only offer the move when another online machine actually has this checkout —
  // otherwise it's advice that leads to the same error on a second box.
  const canMoveElsewhere =
    !!projectPath &&
    devices.some(
      (d) =>
        d.online &&
        d.device_id !== ownerDeviceId &&
        deviceSeesPath(d, projectPath),
    );

  return (
    <div role="alert" className={`shrink-0 flex items-start gap-2 px-4 py-1.5 text-xs ${safety ? "border-b border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-500" : "bg-sol-red/90 text-sol-bg backdrop-blur-sm"}`}>
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        {safety && <div className="font-semibold">Safety review required</div>}
        {tooLarge?.files.length ? (
          <>
            <span className="break-words">
              This project's agent context is {mib(tooLarge.total_bytes)}, over the {mib(tooLarge.cap_bytes)} a cloud host takes. Leaving out {tooLarge.files.length === 1 ? "this file" : `these ${tooLarge.files.length} files`} would fit:
            </span>
            <ul className="mt-1 mb-0.5 space-y-0.5 font-mono opacity-90">
              {tooLarge.files.slice(0, 5).map((f) => (
                <li key={f.path} className="flex gap-2 min-w-0">
                  <span className="truncate" title={f.path}>~/{f.path}</span>
                  <span className="flex-shrink-0 opacity-75">{mib(f.bytes)}</span>
                </li>
              ))}
              {tooLarge.files.length > 5 && <li className="opacity-75">and {tooLarge.files.length - 5} more</li>}
            </ul>
            <span className="opacity-80">They stay on this machine; <code>cast config cloud_mirror_exclude</code> lists them.</span>
          </>
        ) : (
          <span className="break-words">{error}</span>
        )}
        {safety && <p className="mt-1 text-sol-text-dim">{SAFETY_BLOCK_HINT}</p>}
        {canMoveElsewhere && !safety && (
          <span className="opacity-80"> — or move this session to another machine from the header chip.</span>
        )}
      </div>
      {onResume && !safety && tooLarge?.files.length ? (
        <button onClick={() => onResume({ leave_out: tooLarge.files.map((f) => f.path) })} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors flex-shrink-0">
          Leave out and start
        </button>
      ) : onResume && !safety && (
        <button onClick={() => onResume()} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors flex-shrink-0">
          Resume
        </button>
      )}
      <button
        onClick={() => setDismissedError(error)}
        aria-label="Dismiss error"
        className="flex-shrink-0 p-0.5 rounded opacity-70 hover:opacity-100 transition-opacity"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
