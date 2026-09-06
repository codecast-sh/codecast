import { useState } from "react";
import { Terminal } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { copyToClipboard } from "../lib/utils";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useStatusNotice, type StatusNotice } from "../hooks/useStatusNotice";

const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function TmuxMissingBanner() {
  useStatusNotice("tmux-missing", useTmuxMissingNotice());
  return null;
}

// Every hook runs before the first early return, so the notice can bail out
// in whatever order reads best.
function useTmuxMissingNotice(): StatusNotice | null {
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

  return {
    tone: "yellow",
    icon: Terminal,
    title: "tmux is not installed on your machine",
    detail: (
      <>
        inbox messaging and remote session control require it. Install with{" "}
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-xs bg-sol-base02 text-sol-base1 rounded cursor-pointer hover:bg-sol-base01 hover:text-sol-base2 transition-colors"
          title="Click to copy"
        >
          {copied ? "copied!" : installCmd}
        </button>
      </>
    ),
    onDismiss: () => updateDismissed("tmux_missing", Date.now()),
  };
}
