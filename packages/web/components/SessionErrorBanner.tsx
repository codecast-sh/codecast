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

export function SessionErrorBanner({
  error,
  projectPath,
  ownerDeviceId,
  onResume,
}: {
  error: string;
  projectPath?: string | null;
  ownerDeviceId?: string | null;
  onResume?: () => void;
}) {
  const { devices } = useDevices();
  // Keyed by the error text, not a bare boolean: dismissing "no local checkout"
  // must not also swallow whatever the session fails with next.
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  if (!error || dismissedError === error) return null;

  // Only offer the move when another online machine actually has this checkout —
  // otherwise it's advice that leads to the same error on a second box.
  const canMoveElsewhere =
    !!projectPath &&
    devices.some(
      (d) =>
        d.online &&
        d.device_id !== ownerDeviceId &&
        // Prefix, not exact: a repo-subdir session still moves to the machine
        // holding the repo root (same rule as routing's pathUnderRoot).
        d.local_project_roots?.some((r) => projectPath === r || projectPath.startsWith(r.endsWith("/") ? r : r + "/")),
    );

  return (
    <div className="shrink-0 flex items-start gap-2 px-4 py-1.5 bg-sol-red/90 text-sol-bg text-xs backdrop-blur-sm">
      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="break-words">{error}</span>
        {canMoveElsewhere && (
          <span className="opacity-80"> — or move this session to another machine from the header chip.</span>
        )}
      </div>
      {onResume && (
        <button onClick={onResume} className="ml-1 px-1.5 py-0.5 rounded bg-sol-bg/20 hover:bg-sol-bg/30 transition-colors flex-shrink-0">
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
