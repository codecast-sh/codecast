// The screen a page shows when it reads this machine's disk through the local
// daemon and can't reach it. One dead end used to answer several different
// problems; each reason gets its own honest explanation here, shared by every
// page on the loopback bridge (Files, Memory).

import type { ReactNode } from "react";
import { WifiOff } from "lucide-react";
import { isElectron } from "../lib/desktop";
import type { LoopbackUnreachableReason } from "../lib/terminal/endpoint";

export function LocalDaemonUnreachable({
  reason,
  detail,
  what,
  onRetry,
  children,
}: {
  reason: LoopbackUnreachableReason;
  detail: string | null;
  /** What the page reads off the disk, plural and capitalized: "Files", "Memories". */
  what: string;
  onRetry: () => void;
  /** Anything the page can still offer without the daemon. */
  children?: ReactNode;
}) {
  // One dead end used to answer three different problems. The browser blocking
  // a loopback request looks nothing like a daemon that isn't running, and
  // telling someone to restart a healthy daemon wastes their time.
  // A refused probe has two honest readings, and only one of them exists in
  // the desktop app: there is no browser gate in Electron, so pointing at the
  // address bar there sends people hunting for a permission they cannot grant.
  const desktop = isElectron();
  const copy = {
    "daemon-slow": {
      title: "The daemon is running, but slow to answer",
      body: (
        <>
          It&apos;s registered as live, but didn&apos;t respond within the time limit —
          usually a daemon busy with many sessions or a slow tmux. That is load, not a
          browser problem: retry in a moment, and{" "}
          <code className="text-sol-text">cast doctor</code> shows its health.
        </>
      ),
    },
    "probe-failed": {
      title: desktop ? "No daemon answered on this machine" : "This page can't reach the daemon",
      body: desktop ? (
        <>
          A daemon answered, but not one this app can reach — the files live on another
          machine, or the daemon here isn&apos;t running. Start it with{" "}
          <code className="text-sol-text">cast daemon</code> or check{" "}
          <code className="text-sol-text">cast doctor</code>, then retry.
        </>
      ) : (
        <>
          A daemon answered, but the request to it was refused. Either it runs on another
          machine, or the browser blocked the local connection — Chrome asks permission the
          first time a site connects to your local network; allow it from the address-bar
          icon, then retry.
        </>
      ),
    },
    "no-devices": {
      title: "Can't reach the local daemon",
      body: (
        <>
          {what} are read straight from this machine, which needs the codecast daemon
          running. Start it with <code className="text-sol-text">cast daemon</code> or check{" "}
          <code className="text-sol-text">cast doctor</code>. If it IS running, make sure
          you&apos;re signed in as the same account it belongs to.
        </>
      ),
    },
    "old-daemon": {
      title: "This machine's daemon is too old for this",
      body: (
        <>
          It answered, but it doesn&apos;t serve this page yet. Run{" "}
          <code className="text-sol-text">cast update</code> and try again.
        </>
      ),
    },
    refused: {
      title: "The daemon refused this request",
      body: (
        <>
          It answered, but turned the request away — usually a stale
          connection token after a restart. Retry; if it persists, restart the
          daemon.
        </>
      ),
    },
    error: {
      title: "The request didn't go through",
      body: (
        <>
          The daemon is running and answered the first check, but the file call
          failed before reaching it. Retry — the detail below says why.
        </>
      ),
    },
    "other-device": {
      title: `Those ${what.toLowerCase()} are on another machine`,
      body: (
        <>
          They are read straight off the disk they live on, so only that machine can
          serve them. Open this page there.
        </>
      ),
    },
    none: {
      title: "Can't reach the local daemon",
      body: (
        <>
          Start it with <code className="text-sol-text">cast daemon</code> or check{" "}
          <code className="text-sol-text">cast doctor</code>.
        </>
      ),
    },
  }[reason];

  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
      <WifiOff className="w-10 h-10 text-sol-text-dim opacity-40" />
      <div className="text-sol-text font-medium">{copy.title}</div>
      <div className="text-sm text-sol-text-muted max-w-md">{copy.body}</div>
      {detail && (
        <code className="text-[11px] text-sol-text-dim max-w-md break-all">{detail}</code>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="sol-btn text-xs px-3 py-1.5 mt-1"
      >
        Retry connection
      </button>
      {children}
    </div>
  );
}
