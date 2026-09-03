import { useNavigate } from "react-router";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { AppLoader } from "../AppLoader";
import type { SettingsPathHit } from "../../lib/settingsSections";

/**
 * Hard-load landing for legacy settings URLs: open the settings modal and
 * bounce to home (the same home the left sidebar uses — team feed when a team
 * is active, else the inbox). The query string is carried over because modal
 * panels read OAuth/team-setup params from the URL.
 */
export function SettingsRedirect({ hit }: { hit: SettingsPathHit }) {
  // Drive React Router directly, not the tab-aware compat router: this
  // component only mounts on hard-load routes OUTSIDE the tab shell (/cli,
  // legacy /settings/*), but a user with persisted tabs makes the compat
  // replace() take the tab-routing path — a bare replaceState that never
  // unmounts this route, leaving the loader up forever.
  const navigate = useNavigate();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);

  useWatchEffect(() => {
    useInboxStore.getState().openSettingsModal(hit.section);
    const home = activeTeamId ? "/team/activity" : "/inbox";
    // Keep the fragment: OAuth connectors return with their confirm token
    // after the # and the integrations panel reads it once it mounts.
    navigate(home + (hit.search ? `?${hit.search}` : "") + window.location.hash, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <AppLoader />;
}
