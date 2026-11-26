// Event bus between the app's many FilePathLinks and the ONE context-menu
// host (components/FilePathMenuHost). Links are dense in agent prose (dozens
// per message), so each hands its right-click here instead of owning a menu
// instance. Lives in lib/ so the host's component module exports only
// components (Fast Refresh boundary guard).

import type React from "react";
import type { FilePathContextValue } from "./filePathLinks";

export interface FilePathMenuPayload {
  path: string;
  line?: number;
  href: string;
  ctx: FilePathContextValue | null;
}

type Listener = (e: React.MouseEvent, payload: FilePathMenuPayload) => void;
let listener: Listener | null = null;

/** The host registers itself on mount; returns the unregister. */
export function setFilePathMenuListener(next: Listener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

/** Called by a FilePathLink's onContextMenu; no-op until the host mounts. */
export function requestFilePathMenu(e: React.MouseEvent, payload: FilePathMenuPayload): void {
  listener?.(e, payload);
}
