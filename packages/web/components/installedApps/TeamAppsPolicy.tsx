// Team settings > Installed apps: whether members may install pages as
// desktop apps, and whether those apps may get full access (run programs,
// change files). Admins switch them; everyone else sees where they stand.
// Full access going on is a capability handed to every member's apps, so it
// goes through the shared review; every other press is one press.
import { AppWindow } from "lucide-react";
import { teamAppsPolicy } from "@codecast/shared/contracts/pageApp";
import { useInboxStore } from "../../store/inboxStore";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "../settings/ui";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { teamFullAccessLedger } from "../../lib/installedApps";

export function TeamAppsPolicy({ teamId, teamName, isAdmin }: { teamId: string; teamName: string; isAdmin: boolean }) {
  const team = useInboxStore((s) => s.teams.find((t: any) => t?._id === teamId));
  const setPolicy = useInboxStore((s) => s.setTeamAppsPolicy);
  const policy = teamAppsPolicy(team ?? {});
  return (
    <SettingsSection title="Installed apps" icon={AppWindow}>
      <SettingsRow label="Install pages as apps" description="Members, from a page's Share menu">
        <Switch
          checked={policy.install}
          disabled={!isAdmin}
          onCheckedChange={(on) => void setPolicy(teamId, { install: on })}
          aria-label="Install pages as apps"
        />
      </SettingsRow>
      <SettingsRow label="Full access" description="Apps run programs and change files" disabled={!policy.install}>
        <ConsequentialSwitch
          on={policy.fullAccess}
          ledger={teamFullAccessLedger(teamName)}
          onTurnOn={() => void setPolicy(teamId, { full_access: true })}
          onTurnOff={() => void setPolicy(teamId, { full_access: false })}
          trigger={({ on, press, reviewing }) => (
            <span aria-haspopup="dialog" aria-expanded={reviewing} data-team-apps-full-access={on ? "on" : "off"}>
              <Switch checked={on} disabled={!isAdmin || !policy.install} onCheckedChange={press} aria-label="Full access for installed apps" className={on ? "!bg-sol-orange" : ""} />
            </span>
          )}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
