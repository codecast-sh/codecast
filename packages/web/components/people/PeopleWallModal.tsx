// The wall's second home: the main window, over whatever you were doing.
import { useCallback, useRef } from "react";
import { X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCallsAvailable } from "../../lib/teamFeatures";
import { useEventListener } from "../../hooks/useEventListener";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ErrorBoundary } from "../ErrorBoundary";
import { PeopleWall } from "./PeopleWall";
import { PopOutPeopleButton } from "./PopOutPeopleButton";

/**
 * The wall, without the window.
 *
 * The people window is the wall's home, and on a machine with room for a second
 * window that is where it should live — pinned beside the work, always there.
 * But the wall answers a question you have while you are in the middle of
 * something ("who is around, and can I just ask them?"), and making the answer
 * cost a window is making it cost a decision. So the main window can throw the
 * same wall over the top of itself for as long as it takes to hold one face,
 * and put it away again.
 *
 * It is the SAME component, not a second one. Everything the wall is — the
 * sizes, the hold, the rings, the tap that opens the DM — is whatever
 * PeopleWall does, here as well as there. The panel around it differs, because
 * this one is a thing you dismiss and that one is a place you stand.
 *
 * Mounted only while open, so the always-mounted rules the panel lives under
 * do not apply: nothing here subscribes to anything when it is shut.
 */
export function PeopleWallModal() {
  const open = useInboxStore((s) => s.peopleWallOpen);
  const callsEnabled = useCallsAvailable();
  const close = useCallback(() => useInboxStore.getState().closePeopleWall(), []);

  const backdropRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  // Take focus on open and give it back on close. Without it, opening from the
  // palette leaves focus in the composer behind the wall, and Space — which is
  // how a keyboard holds a face — lands in the message somebody was writing.
  useWatchEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      const prev = restoreFocusRef.current;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [open]);

  useEventListener(
    "keydown",
    useCallback(
      (e: KeyboardEvent) => {
        if (!open || e.key !== "Escape") return;
        e.stopPropagation();
        close();
      },
      [open, close],
    ),
    document,
  );

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-3 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(e) => {
        if (e.target === backdropRef.current) close();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="The team"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="animate-fadeSlideIn flex max-h-[min(680px,92dvh)] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-sol-border bg-sol-bg shadow-2xl outline-none"
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-sol-border px-4 py-2.5">
          <div>
            <h2 className="text-[13px] font-medium text-sol-text">The team</h2>
            {/* The gesture, said once, because a circle cannot say it. The
                composer's key gets a coach mark for the same reason. */}
            <p className="text-[11px] text-sol-text-dim">
              Hold a face to talk. Click one to open the conversation.
            </p>
          </div>
          <div className="flex items-center gap-1">
            {/* The way OUT of the overlay and into the window that keeps it:
                somebody who opens this three times in a morning wants the
                pinned version, and this is where they find out it exists. */}
            <PopOutPeopleButton
              className="flex h-7 w-7 items-center justify-center rounded-md text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
              onDone={close}
            />
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded-md text-sol-text-dim transition-colors hover:bg-sol-bg-highlight hover:text-sol-text"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="people-scroll min-h-0 flex-1 overflow-y-auto">
          <ErrorBoundary name="People wall" level="inline" fallback={null}>
            <PeopleWall callsEnabled={callsEnabled} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
