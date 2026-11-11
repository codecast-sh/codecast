"use client";
/**
 * Per-team opt-in features (chat, calls, org, flows) — one switch per catalog
 * entry, admin only. A feature with a guide (tours/guides) offers it beside
 * its switch. A new team starts with the catalog's onByDefault features on
 * (DEFAULT_TEAM_FEATURES). Off means NO UI anywhere for that feature; on shows
 * it for every member of this team and installs the matching agent snippets on
 * their machines (the daemon reconciles on its next heartbeat). Catalog:
 * @codecast/shared/contracts/teamFeatures — the same list the server guards on.
 *
 * Local-first: the flip lands in the store's teams list synchronously (the
 * sidebar row appears or vanishes as you click) through the store's
 * setTeamFeature action; a refusal puts it back and toasts like any dispatch.
 */
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ToggleLeft } from "lucide-react";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./ui";
import { featureVendorBlock, TEAM_FEATURES, teamFeatureEnabled } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { GUIDE_FOR } from "../../tours/guides";
import { startTour } from "../../tours/engine";

export function TeamFeaturesEditor({ teamId, isAdmin }: { teamId: Id<"teams">; isAdmin: boolean }) {
  const team = useInboxStore((s) => (s.teams || []).find((t: any) => String(t._id) === String(teamId)));
  const staff = useInboxStore((s) => (s.currentUser as { staff?: boolean } | null | undefined)?.staff === true);

  return (
    <SettingsSection
      title="Features"
      icon={ToggleLeft}
      description={
        <>
          On shows a feature to everyone on this team and adds its agent commands on their machines.
          {!isAdmin && " Only team admins can change these."}
        </>
      }
    >
      {TEAM_FEATURES.map((f) => {
        // A regulated team cannot turn on a feature whose vendor has no BAA yet; the row says which.
        const blocked = featureVendorBlock(team, f.key);
        const on = !blocked && teamFeatureEnabled(team, f.key);
        return (
          <SettingsRow key={f.key} label={f.name} description={blocked ?? f.desc}>
            {GUIDE_FOR[f.key] && (
              <button type="button" onClick={() => startTour(GUIDE_FOR[f.key]!, { replay: true })} className="mr-3 text-xs text-sol-text-dim hover:text-sol-text transition-colors whitespace-nowrap" data-feature-guide={f.key}>
                Watch the guide
              </button>
            )}
            <Switch
              checked={on}
              disabled={!isAdmin || !!blocked || (!on && !!f.inDevelopment && !staff)}
              onCheckedChange={(v) => useInboxStore.getState().setTeamFeature(teamId, f.key, v)}
              aria-label={f.name}
            />
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
