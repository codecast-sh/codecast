// The setup banner's one decision (components/SetupPromptBanner).

/** What the banner asks for: the CLI when this account has never run one, the
 *  daemon when the CLI is there and nothing has synced yet, nothing once
 *  sessions arrive from an installed CLI. */
export function setupPromptMessage(hasCliInstalled: boolean, hasSessions: boolean): string | null {
  if (!hasCliInstalled) return "Install the CLI to start syncing your Claude Code sessions";
  if (!hasSessions) return "Start the daemon to sync your first session";
  return null;
}
