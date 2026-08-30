"use client";
/**
 * Per-team opt-in features (chat, calls) — one switch per catalog entry, admin
 * only. Off is the default and means NO UI anywhere for that feature; on shows
 * it for every member of this team and installs the matching agent snippets on
 * their machines (the daemon reconciles on its next heartbeat). Catalog:
 * @codecast/shared/contracts/teamFeatures — the same list the server guards on.
 *
 * Local-first: the flip lands in the store's teams list synchronously (the
 * sidebar row appears or vanishes as you click), then the server echo through
 * teams.getUserTeams reconciles.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { ToggleLeft } from "lucide-react";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./ui";
import { TEAM_FEATURES, teamFeatureEnabled, type TeamFeatureKey } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";

export function TeamFeaturesEditor({ teamId, isAdmin }: { teamId: Id<"teams">; isAdmin: boolean }) {
  const setTeamFeature = useMutation(api.teamFeatures.setTeamFeature);
  const team = useInboxStore((s) => (s.teams || []).find((t: any) => String(t._id) === String(teamId)));
  const [busy, setBusy] = useState<TeamFeatureKey | null>(null);

  const flip = async (key: TeamFeatureKey, enabled: boolean) => {
    if (!isAdmin || busy) return;
    setBusy(key);
    const store = useInboxStore.getState();
    const before = store.teams;
    store.syncTable(
      "teams",
      (before || []).map((t: any) =>
        String(t._id) === String(teamId) ? { ...t, features: { ...(t.features ?? {}), [key]: enabled } } : t,
      ),
    );
    try {
      await setTeamFeature({ team_id: teamId, feature: key, enabled });
    } catch (e: any) {
      useInboxStore.getState().syncTable("teams", before);
      toast.error(e?.message || "Could not update the feature");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection
      title="Features"
      icon={ToggleLeft}
      description={
        <>
          Off by default. Turning one on shows it to everyone on this team and adds the matching
          agent commands on their machines.
          {!isAdmin && " Only team admins can change these."}
        </>
      }
    >
      {TEAM_FEATURES.map((f) => {
        const on = teamFeatureEnabled(team, f.key);
        return (
          <SettingsRow key={f.key} label={f.name} description={f.desc}>
            <Switch
              checked={on}
              disabled={!isAdmin || busy === f.key}
              onCheckedChange={(v) => void flip(f.key, v)}
              aria-label={f.name}
            />
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
