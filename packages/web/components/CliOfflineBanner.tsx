import { useState } from "react";
import { LogIn, ShieldOff, Terminal } from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { bridge } from "../lib/desktop";
import { useInboxStore } from "../store/inboxStore";
import { copyToClipboard } from "../lib/utils";
import { useMountEffect } from "../hooks/useMountEffect";
import { useCurrentUser } from "../hooks/useCurrentUser";
import {
  offlineTierFor,
  formatDuration,
  type OfflineTier,
} from "../hooks/useDaemonHealth";
import { useLocalDaemonHealth } from "../hooks/useLocalDaemonHealth";
import { useAppOffline } from "../hooks/useAppOffline";
import { useStatusNotice, type StatusNotice } from "../hooks/useStatusNotice";

const DISMISS_DURATION_MS = 30 * 60 * 1000;

const TIER_TONE: Record<OfflineTier, StatusNotice["tone"]> = { warn: "yellow", alert: "orange", severe: "red" };

export function CliOfflineBanner() {
  const signedOut = useSignedOutNotice();
  const offline = useCliOfflineNotice();
  // A refused sign-in also stops the beats, so the machine reads as offline;
  // restarting would not help, signing in again does.
  useStatusNotice("cli-offline", signedOut ?? offline);
  return null;
}

const SIGNED_OUT_POLL_MS = 60_000;

// In the desktop app the shell reads this machine's daemon state
// (daemonSetup.js): a sign-in the server keeps refusing gets a one-click
// sign in again, which reruns the setup with a fresh setup token.
function useSignedOutNotice(): StatusNotice | null {
  const createSetupToken = useMutation(api.apiTokens.createSetupToken);
  const [authFailed, setAuthFailed] = useState(false);
  const [removedBy, setRemovedBy] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "failed">("idle");
  const probe = () => bridge("getDaemonSetup")?.().then((m) => { setAuthFailed(m.authFailed === true); setRemovedBy(m.removedBy ?? null); }).catch(() => {});
  useMountEffect(() => {
    if (!bridge("getDaemonSetup")) return;
    void probe();
    const timer = setInterval(probe, SIGNED_OUT_POLL_MS);
    window.addEventListener("focus", probe);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", probe);
    };
  });
  const run = bridge("runDaemonSetup");
  if (!authFailed || !run) return null;
  // Removed by its team: signing in again is the admins' call, not this button's.
  if (removedBy) return { tone: "red", icon: ShieldOff, title: `${removedBy}'s admins removed this Mac. Nothing syncs.` };

  const signIn = async () => {
    setPhase("running");
    try {
      const { token } = await createSetupToken({});
      const result = await run(token);
      setPhase(result.ok ? "idle" : "failed");
    } catch {
      setPhase("failed");
    }
    await probe();
  };

  return {
    tone: "red",
    icon: LogIn,
    title: "This machine is signed out. Nothing syncs.",
    detail: phase === "failed" ? <>Sign in did not finish. Run <code className="font-mono">cast auth</code> on this machine.</> : undefined,
    action: (
      <button
        onClick={signIn}
        disabled={phase === "running"}
        className="px-2 py-0.5 text-xs font-medium rounded bg-sol-red/20 text-sol-red hover:bg-sol-red/30 disabled:opacity-60"
      >
        {phase === "running" ? "Signing in…" : "Sign in again"}
      </button>
    ),
  };
}

// Every hook runs before the first early return, so the notice can bail out
// in whatever order reads best.
function useCliOfflineNotice(): StatusNotice | null {
  const dismissedTs = useInboxStore(s => s.clientState.dismissed?.cli_offline ?? 0);
  const updateDismissed = useInboxStore(s => s.updateClientDismissed);
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  const { user } = useCurrentUser();
  // Share the daemon-health hook with the chip so both get the same wall-clock
  // freshness and the post-wake grace (raw Date.now() here would re-introduce
  // the false "offline" banner that climbs while a stalled subscription freezes
  // daemon_last_seen).
  const health = useLocalDaemonHealth();
  // When this client itself has no connection, daemon_last_seen is stale
  // because WE can't sync — that's the ConnectionBanner's story, not the CLI's.
  const { offline: appOffline } = useAppOffline();

  useMountEffect(() => { setMounted(true); });

  if (!mounted) return null;
  if (appOffline) return null;
  if (user === undefined) return null;
  if (health.kind !== "offline") return null;

  const tier = health.tier;
  const offlineDuration = health.offlineMs;
  // Dismiss math needs how stale the daemon was at the moment of dismissal.
  // Derived from the health verdict (per device) rather than the user doc,
  // which is last-writer across machines.
  const lastSeen = Date.now() - offlineDuration;

  // Honor dismiss only while we're in the same (or lower) tier than when it was dismissed.
  // If the situation has escalated to a worse tier since dismiss, surface the banner again.
  const dismissedOfflineDuration = dismissedTs > 0 ? dismissedTs - lastSeen : -1;
  const dismissedTier = dismissedOfflineDuration > 0 ? offlineTierFor(dismissedOfflineDuration) : null;
  const dismissActive = dismissedTs > 0 && Date.now() - dismissedTs < DISMISS_DURATION_MS;
  const tierEscalated =
    dismissedTier === null
      ? tier !== "warn" // dismiss happened before any tier, so any tier is an escalation
      : (tier === "severe" && dismissedTier !== "severe") ||
        (tier === "alert" && dismissedTier === "warn");
  if (dismissActive && !tierEscalated) return null;

  const command = tier === "warn" ? "cast status" : "cast restart";
  const stale = formatDuration(offlineDuration);
  const who = health.device ? `CLI on ${health.device}` : "CLI";
  const message = tier === "warn" ? `${who} hasn't synced in ${stale}.` : `${who} offline for ${stale}.`;
  const action = tier === "warn" ? "Check status with " : "Restart with ";

  const handleCopy = async () => {
    await copyToClipboard(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return {
    tone: TIER_TONE[tier],
    icon: Terminal,
    title: message,
    detail: (
      <>
        {action}
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-xs bg-sol-base02 text-sol-base1 rounded cursor-pointer hover:bg-sol-base01 hover:text-sol-base2 transition-colors"
          title="Click to copy"
        >
          {copied ? "copied!" : command}
        </button>
      </>
    ),
    onDismiss: () => updateDismissed("cli_offline", Date.now()),
  };
}
