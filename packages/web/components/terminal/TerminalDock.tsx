"use client";

// Mount-point for the integrated terminal. The panel loads once the app is
// idle, before anyone asks for it, and stays mounted (hidden when closed), so
// opening the dock shows a shell that is already connected and live terminals
// survive close/reopen.

import { Suspense, lazy, useState } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";

const TerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

export function TerminalDock() {
  const open = useInboxStore((s) => s.workspace.dock.pane != null);
  const [warm, setWarm] = useState(false);
  useWatchEffect(() => {
    if (warm) return;
    if (open) {
      setWarm(true);
      return;
    }
    const ric = typeof requestIdleCallback === "function" ? requestIdleCallback : null;
    const handle = ric ? ric(() => setWarm(true), { timeout: 4000 }) : window.setTimeout(() => setWarm(true), 2000);
    return () => (ric ? cancelIdleCallback(handle) : clearTimeout(handle));
  }, [open, warm]);
  if (!warm) return null;
  return (
    <Suspense fallback={null}>
      <TerminalPanel />
    </Suspense>
  );
}
