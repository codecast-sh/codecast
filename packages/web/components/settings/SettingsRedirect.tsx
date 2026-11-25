import { useNavigate } from "react-router";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { holdConnectorReturn } from "../../hooks/useConnectorReturn";
import { strippedUrl } from "../../lib/connectorReturn";
import { AppLoader } from "../AppLoader";
import type { SettingsPathHit } from "../../lib/settingsSections";

/**
 * Hard-load landing for legacy settings URLs: open the settings modal and
 * bounce to home (the same home the left sidebar uses — team feed when a team
 * is active, else the inbox). The query string is carried over because modal
 * panels read team-setup params from the URL; an OAuth return is held for the
 * integrations panel instead (holdConnectorReturn).
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
    // Before the move: an OAuth return's confirm token would not survive it.
    holdConnectorReturn(hit.search ? `?${hit.search}` : "", window.location.hash);
    useInboxStore.getState().openSettingsModal(hit.section);
    const home = activeTeamId ? "/team/activity" : "/inbox";
    // Panels still read their own params (team setup) from the address; the
    // connector callback goes only through the hold above.
    navigate(strippedUrl(home, hit.search ? `?${hit.search}` : "", window.location.hash), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <AppLoader />;
}
