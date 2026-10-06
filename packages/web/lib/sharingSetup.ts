type SharingSetupState = {
  clientState: { dismissed?: { sharing_setup?: number } };
  currentUser?: {
    cli_version?: string | null;
    daemon_last_seen?: number | null;
    last_heartbeat?: number | null;
    _creationTime?: number;
  } | null;
  sessions: Record<string, unknown>;
};

export function shouldShowSharingSetup(state: SharingSetupState, now = Date.now()): boolean {
  if ((state.clientState.dismissed?.sharing_setup ?? 0) > 0) return false;
  const user = state.currentUser;
  if (!user || !(user.cli_version || user.daemon_last_seen || user.last_heartbeat)) return false;
  if (typeof user._creationTime !== "number" || !(now - user._creationTime < 14 * 24 * 60 * 60 * 1000)) return false;
  for (const _ in state.sessions) return true;
  return false;
}
