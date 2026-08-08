"use client";

// Lazy mount-point for the integrated terminal. xterm and the panel only
// download when the terminal is first opened; after that the panel stays
// mounted (hidden when closed) so live terminals survive close/reopen.

import { Suspense, lazy, useRef } from "react";
import { useInboxStore } from "../../store/inboxStore";

const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

export function TerminalDock() {
  const open = useInboxStore((s) => s.workspace.dock.pane != null);
  const everOpened = useRef(false);
  if (open) everOpened.current = true;
  if (!everOpened.current) return null;
  return (
    <Suspense fallback={null}>
      <TerminalPanel />
    </Suspense>
  );
}
