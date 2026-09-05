import { useState } from "react";
import { X, Terminal } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { copyToClipboard } from "../lib/utils";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useStatusToast } from "../hooks/useStatusToast";

const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function TmuxMissingBanner() {
  useStatusToast("tmux-missing", useTmuxMissingNotice());
  return null;
}

// Every hook runs before the first early return, so the notice can bail out
// in whatever order reads best.
function useTmuxMissingNotice() {
  const initialized = useInboxStore(s => s.clientStateInitialized);
  const dismissedTs = useInboxStore(s => s.clientState.dismissed?.tmux_missing ?? 0);
  const updateDismissed = useInboxStore(s => s.updateClientDismissed);
  const [copied, setCopied] = useState(false);

  const { user } = useCurrentUser();

  const isDismissed = dismissedTs > 0 && Date.now() - dismissedTs < DISMISS_DURATION_MS;

  if (!initialized || isDismissed) return null;
  if (user === undefined) return null;
  if (user?.has_tmux !== false) return null;

  const lastSeen = user?.daemon_last_seen || user?.last_heartbeat;
  if (!lastSeen || Date.now() - lastSeen > 24 * 60 * 60 * 1000) return null;

  const isMac = user?.cli_platform === "darwin";
  const installCmd = isMac ? "brew install tmux" : "sudo apt-get install -y tmux";

  const handleCopy = async () => {
    await copyToClipboard(installCmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-gradient-to-r from-sol-yellow/10 via-sol-orange/10 to-sol-yellow/10 border border-sol-yellow/30 rounded-lg">
      <div className="px-4 py-2 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <Terminal className="w-4 h-4 mt-0.5 text-sol-yellow flex-shrink-0" />
          <span className="text-sm text-sol-text leading-snug">
            tmux is not installed on your machine. Inbox messaging and remote session control require tmux.
            {" "}Install with{" "}
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-xs bg-sol-base02 text-sol-base1 rounded cursor-pointer hover:bg-sol-base01 hover:text-sol-base2 transition-colors"
              title="Click to copy"
            >
              {copied ? "copied!" : installCmd}
            </button>
          </span>
        </div>
        <button
          onClick={() => updateDismissed("tmux_missing", Date.now())}
          className="p-1 text-sol-text-dim hover:text-sol-text transition-colors flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
