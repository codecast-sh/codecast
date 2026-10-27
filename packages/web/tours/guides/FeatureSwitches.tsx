"use client";
// A team feature's switch, wherever a guide or its landing offers it. The same
// store action the team settings use (TeamFeaturesEditor), so flipping it
// here is flipping it there: the sidebar row appears as it is pressed, and a
// refusal puts it back. An admin sees the switch for the team they are in (in
// the personal workspace, every team they run); a member sees who can turn it
// on.
import { teamFeatureEnabled, type TeamFeatureKey } from "@codecast/shared/contracts";
import { Switch } from "../../components/ui/switch";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { activeTeamIdOf } from "../../lib/activeTeam";

const isAdminRole = (role: unknown) => role === "admin" || role === "owner";

export function FeatureSwitches({ feature, name }: { feature: TeamFeatureKey; name: string }) {
  const s = useTrackedStore([(st) => st.teams, (st) => activeTeamIdOf(st), (st) => st.teamMembers]);
  const teams: any[] = (s.teams || []).filter(Boolean);
  const activeId = activeTeamIdOf(s);
  const active = teams.find((t) => String(t._id) === String(activeId)) ?? null;
  const shown = active ? [active] : teams.filter((t) => isAdminRole(t.role));
  const admins = active && !isAdminRole(active.role)
    ? (s.teamMembers || []).filter((m: any) => m && isAdminRole(m.role)).map((m: any) => m.name || m.github_username).filter(Boolean)
    : [];

  return (
    <div className="guide-switches" data-feature-switches={feature}>
      {shown.length === 0 && <p className="guide-dim">Switches are per team. Create or join a team to turn {name} on.</p>}
      {shown.map((t) => {
        const admin = isAdminRole(t.role);
        const on = teamFeatureEnabled(t, feature);
        return (
          <label key={String(t._id)} className="guide-switch-row" data-on={on ? "" : undefined} data-guide-switch={String(t._id)}>
            <span className="guide-switch-team">
              <span className="guide-switch-name">{t.name}</span>
              <span className="guide-switch-state">{on ? "On for everyone on the team" : admin ? "Off" : "Off · an admin turns it on"}</span>
            </span>
            <Switch
              checked={on}
              disabled={!admin}
              onCheckedChange={(v) => useInboxStore.getState().setTeamFeature(String(t._id), feature, v)}
              aria-label={`${name} for ${t.name}`}
            />
          </label>
        );
      })}
      {admins.length > 0 && !teamFeatureEnabled(active, feature) && (
        <p className="guide-dim">Ask {admins.slice(0, 3).join(", ")} to turn it on.</p>
      )}
    </div>
  );
}
