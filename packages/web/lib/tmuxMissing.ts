// The signed-in person's machine reported it has no tmux (users.has_tmux,
// written by the daemon), recently enough to still be true. Without tmux the
// daemon cannot start, resume or type into a session, so a restart never helps;
// the fix is this install command. Read by the top bar (TmuxMissingBanner) and
// by a message waiting to be delivered (PendingDeliveryNote).
export function tmuxInstallCommand(
  user: { has_tmux?: boolean; daemon_last_seen?: number; last_heartbeat?: number; cli_platform?: string } | null | undefined,
  now: number = Date.now(),
): string | null {
  if (user?.has_tmux !== false) return null;
  const lastSeen = user.daemon_last_seen || user.last_heartbeat;
  if (!lastSeen || now - lastSeen > 24 * 60 * 60 * 1000) return null;
  return user.cli_platform === "darwin" ? "brew install tmux" : "sudo apt-get install -y tmux";
}
