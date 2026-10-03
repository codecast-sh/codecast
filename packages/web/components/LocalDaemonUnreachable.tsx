// The screen a page shows when it reads this machine's disk through the local
// daemon and can't reach it. One dead end used to answer several different
// problems; each reason gets its own honest explanation here, shared by every
// page on the loopback bridge (Files, Memory, Evals).

import type { ReactNode } from "react";
import { WifiOff } from "lucide-react";
import { isElectron } from "../lib/desktop";
import type { LoopbackUnreachableReason } from "../lib/terminal/endpoint";

/** The daemon answered, but what it serves cannot: the evals' two reasons
 *  (the bridge found no checkout to run, or the process it ran crashed). */
export type LocalUnreachableReason = LoopbackUnreachableReason | "no-checkout" | "child-crashed";

export function LocalDaemonUnreachable({
  reason,
  detail,
  stderr,
  what,
  onRetry,
  children,
}: {
  reason: LocalUnreachableReason;
  detail: string | null;
  /** The crashed process's last stderr lines, shown for `child-crashed`. */
  stderr?: string[] | null;
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
    "no-checkout": {
      title: "No codecast checkout has run ./evals on this machine",
      body: (
        <>
          {what} live on the laptop that ran them, read off its disk by the eval
          tool in that checkout. Run <code className="text-sol-text">./evals</code> once
          from your codecast checkout here, or open this page on the machine that ran them.
        </>
      ),
    },
    "child-crashed": {
      title: "The evals process crashed",
      body: (
        <>
          The daemon started the eval tool from your checkout and it exited. A checkout
          that is mid-edit does this; its own error is below. Fix it, then retry.
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
        <code className="text-[11px] text-sol-text-dim max-w-md [overflow-wrap:anywhere]">{detail}</code>
      )}
      {stderr && stderr.length > 0 && (
        <pre
          data-unreachable-stderr
          className="max-w-2xl w-full max-h-64 overflow-auto text-left text-[11px] leading-relaxed font-mono text-sol-text-secondary bg-sol-bg-inset border border-sol-border/40 rounded-md px-3 py-2 whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {stderr.join("\n")}
        </pre>
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
