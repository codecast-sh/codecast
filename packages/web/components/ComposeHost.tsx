import { Suspense, useRef } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useMountEffect } from "../hooks/useMountEffect";
import { useFlipAnimation } from "../hooks/useFlipAnimation";
import { composeViewComponent } from "../lib/composeViewLoader";

/**
 * Hosts every open new-session composer (store/composeSlice.ts). The center
 * modal and the docked composers are siblings in ONE container, keyed by
 * instance id, and differ only in the frame's classes: minimizing the modal or
 * expanding a dock re-styles the frame around the same mounted ComposeView, so
 * nothing about the session being composed is handed over or rebuilt. Sibling
 * order never changes (moving a DOM node blurs the textarea inside it); the
 * backdrop and the modal rise by z-index instead.
 */
export function ComposeHost() {
  const composes = useInboxStore((s) => s.composes);
  const closeCompose = useInboxStore((s) => s.closeCompose);
  // ComposeView's guarded close (draft keep/discard confirm) — the backdrop
  // routes clicks through it. Null until the modal mounts.
  const closeGuardRef = useRef<(() => void) | null>(null);
  const { containerRef, beforeReorder } = useFlipAnimation({ scale: true, durationMs: 240 });
  // Store subscribers run inside set(), before React commits: the frames still
  // sit where they were, which is the "first" measurement a FLIP needs. This
  // covers every way the layout changes (buttons, the shortcut, a send).
  useMountEffect(() => useInboxStore.subscribe((st, prev) => { if (st.composes !== prev.composes) beforeReorder(); }));

  if (composes.length === 0) return null;
  const hasModal = composes.some((c) => c.mode === "modal");
  const ComposeView = composeViewComponent();
  return (
    <div ref={containerRef} className="fixed inset-x-0 bottom-0 z-[200] flex flex-row-reverse items-end gap-3 px-4 pointer-events-none">
      {hasModal && (
        <div
          className="fixed inset-0 z-10 bg-black/60 pointer-events-auto animate-in fade-in-0 duration-150"
          onClick={() => (closeGuardRef.current ?? closeCompose)()}
        />
      )}
      {composes.map((c) => (
        <div
          key={c.id}
          data-flip-key={c.id}
          className={c.mode === "modal"
            ? "fixed inset-x-0 top-[12vh] z-20 mx-auto w-fit pointer-events-auto"
            : "min-w-0 pointer-events-auto"}
        >
          <Suspense fallback={null}>
            <ComposeView
              instance={c}
              initialQuery={c.initialQuery}
              context={c.context}
              onClose={() => closeCompose(c.id)}
              closeGuardRef={c.mode === "modal" ? closeGuardRef : undefined}
            />
          </Suspense>
        </div>
      ))}
    </div>
  );
}
