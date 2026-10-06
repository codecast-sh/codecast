// The one integrations surface (docs/architecture/issue-sync.md S9): the
// assistant's mail and calendar through Whisk (WhiskCard), then Slack,
// GitHub, Linear, Google and Notion, each with connect, disconnect, who
// connected it, health, and what it enables — plus the imported issue sources
// inside the GitHub and Linear cards.
//
// Two ledgers, because a connection belongs to exactly one workspace
// (appDescriptors.ts SCOPE): the team the reader is looking at, and the reader
// themself. A team connection serves the team inside the team; a personal one
// follows its owner into every workspace they work in, and a credential
// resolver reaches for it whenever the work's team has none of its own.
//
// It replaces the old /settings/integrations/github-app page, whose installed
// accounts and repository list now live inside the GitHub card.
//
// This page also finishes an OAuth connection (hooks/useConnectorReturn): the
// connectors redirect back here with a confirm token in the URL fragment, which
// is read once, spent in this signed-in session, and cleared.

import { Sparkles, User, Users } from "lucide-react";
import {
  APP_DESCRIPTORS,
  APP_IDS,
  type AppConnectionScope,
  type AppConnectionStatus,
  type AppConnectionsResult,
} from "@codecast/shared/contracts";
import { useSettingsData } from "../../../hooks/useSyncSettings";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useConnectorReturn } from "../../../hooks/useConnectorReturn";
import { SettingsCallout, SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { IntegrationCard } from "../../../components/integrations/IntegrationCard";
import { WhiskCard } from "../../../components/integrations/WhiskCard";
import { SourcesSection } from "../../../components/ops/SourcesSection";
import { BrowserExtensionSetup } from "../../../components/settings/BrowserExtensionSetup";
import { TeamSwitcher } from "../../../components/TeamSwitcher";
import { useInboxStore } from "../../../store/inboxStore";
import { describeConnectorError } from "../../../lib/connectorReturn";

/** The entries at one scope, keyed by app, for the cards of that ledger. */
function entriesAt(result: AppConnectionsResult | undefined, scope: AppConnectionScope) {
  return new Map<string, AppConnectionStatus>(
    (result?.apps ?? [])
      .filter((a) => a.status === "coming_soon" || a.scope === scope)
      .map((a) => [a.id, a]),
  );
}

export default function IntegrationsPage() {
  const connections = useSettingsData("connections");
  const { user } = useCurrentUser();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const notice = useConnectorReturn();

  const result = connections.data as AppConnectionsResult | undefined;
  const loading = result === undefined && !connections.error;
  // The team ledger answers for a team only once the query has said which;
  // until then the section renders as unknown, never as "no team".
  const team = result?.team ?? null;
  const teamKnown = result !== undefined;
  const teamEntries = entriesAt(result, "team");
  const personalEntries = entriesAt(result, "personal");

  const errorCallout = connections.error && (
    <div className="px-4 py-3 sm:px-5">
      <SettingsCallout tone="warning">
        Couldn&apos;t load connection state: {connections.error.message}. The cards below say nothing
        rather than guessing.
      </SettingsCallout>
    </div>
  );

  return (
    <SettingsPanel>
      {notice?.kind === "error" && (
        <SettingsCallout tone="danger">
          {notice.provider ? `${APP_DESCRIPTORS[notice.provider].name}: ` : ""}
          {describeConnectorError(notice.reason)}
        </SettingsCallout>
      )}

      {/* The assistant's own connection: mail and calendar through Whisk,
          personal, and first because it is what hosted mode runs on. */}
      <SettingsSection title="Assistant" icon={Sparkles}>
        <WhiskCard />
      </SettingsSection>

      <BrowserExtensionSetup />

      <SettingsSection
        title="Team connections"
        icon={Users}
        // The picker names the team the cards below belong to and switches the
        // workspace to another. The client's own pointer leads while a switch
        // is in flight; the server's answer stands in when the client is on
        // Personal, since the ledger then falls back to the home team.
        actions={<TeamSwitcher teamsOnly value={activeTeamId ?? team?.id ?? null} />}
        description="Shared by everyone on the team picked here, for work inside it. Tokens stay server-side — an agent asks the backend to act, it never holds the credential."
      >
        {errorCallout}
        {teamKnown && !team ? (
          <div className="px-4 py-3 sm:px-5">
            <SettingsCallout tone="info">
              You&apos;re not looking at a team you belong to. Join or create one to connect services for a
              team, or connect them for yourself below.
            </SettingsCallout>
          </div>
        ) : (
          APP_IDS.filter((id) => APP_DESCRIPTORS[id].scopes.includes("team")).map((id) => (
            <IntegrationCard
              key={id}
              descriptor={APP_DESCRIPTORS[id]}
              scope="team"
              connection={teamEntries.get(id)}
              loading={loading}
              me={user}
              showSources={!!team}
            />
          ))
        )}
      </SettingsSection>

      <SettingsSection
        title="Personal connections"
        icon={User}
        description="Yours alone, and they follow you: in any workspace you work in that has no connection of its own, an agent acting for you acts through these."
      >
        {APP_IDS.filter((id) => APP_DESCRIPTORS[id].scopes.includes("personal")).map((id) => (
          <IntegrationCard
            key={id}
            descriptor={APP_DESCRIPTORS[id]}
            scope="personal"
            connection={personalEntries.get(id)}
            loading={loading}
            me={user}
            showSources={teamKnown && !team}
          />
        ))}
      </SettingsSection>

      <SourcesSection />
    </SettingsPanel>
  );
}
