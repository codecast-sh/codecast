"use client";

import { WatchMock } from "../../../features/cloud/Host";
import { CLOUD_CSS } from "../../../features/cloud/motion";

/**
 * Figures for the remote and cloud sessions guide, drawn with the cloud
 * feature page's own pieces.
 */

/** The browser watch beside a cloud session: the agent's tab, live, with Take the wheel for a sign-in. */
export function BrowserWatchFigure() {
  return (
    <div className="p-3 sm:p-5">
      <style>{CLOUD_CSS}</style>
      <WatchMock />
    </div>
  );
}
