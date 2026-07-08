import { useRouter } from "next/navigation";
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
  const router = useRouter();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);

  useWatchEffect(() => {
    useInboxStore.getState().openSettingsModal(hit.section);
    const home = activeTeamId ? "/team/activity" : "/inbox";
    router.replace(home + (hit.search ? `?${hit.search}` : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <AppLoader />;
}
