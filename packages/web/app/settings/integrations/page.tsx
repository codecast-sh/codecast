// The one integrations surface (docs/architecture/issue-sync.md S9): Slack,
// GitHub, Linear, Google and Notion, each with connect, disconnect, scope, who
// connected it, health, and what it enables — plus the imported issue sources
// inside the GitHub and Linear cards.
//
// It replaces the old /settings/integrations/github-app page, whose installed
// accounts and repository list now live inside the GitHub card.
//
// This page also finishes an OAuth connection. The connectors redirect back
// here with a confirm token in the URL FRAGMENT, because the redirect lands in
// whatever browser the provider chose and only the signed-in session that
// started the flow may complete it. The token is read once, spent, and cleared
// from the address bar.

import { useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Plug } from "lucide-react";
import { APP_DESCRIPTORS, APP_IDS, type AppConnectionStatus } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { SettingsCallout, SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { IntegrationCard } from "../../../components/integrations/IntegrationCard";
import {
  describeConnectorError,
  parseConnectorReturn,
  strippedUrl,
  type ConnectorReturn,
} from "../../../lib/connectorReturn";

const api = _api as any;

export default function IntegrationsPage() {
  const connections = useQueryNoThrow(api.appConnections.listConnections, {});
  const me = useQueryNoThrow(api.users.getCurrentUser, {});
  const confirmConnector = useAction(api.oauthConnectors.confirmConnection);
  const confirmGoogle = useAction(api.googleOAuth.confirmConnection);
  const [notice, setNotice] = useState<ConnectorReturn | null>(null);

  // Read the callback ONCE, on mount, then clear it. Re-reading it would let a
  // back-navigation replay a confirmation the user already spent.
  useWatchEffect(() => {
    const hit = parseConnectorReturn(window.location.hash, window.location.search);
    if (!hit) return;
    window.history.replaceState(
      null,
      "",
      strippedUrl(window.location.pathname, window.location.search, window.location.hash),
    );
    if (hit.kind !== "confirm") {
      setNotice(hit);
      if (hit.kind === "success") toast.success("GitHub App installed");
      return;
    }
    // Google's connector and the generic one take the same two arguments and
    // differ only in which module owns the installation row.
    const confirm = hit.provider === "gmail" ? confirmGoogle : confirmConnector;
    const name = APP_DESCRIPTORS[hit.provider].name;
    void (async () => {
      try {
        const res = await confirm({ installation_id: hit.installationId, confirm_token: hit.confirmToken });
        if (res?.ok) toast.success(`${name} connected`);
        else setNotice({ kind: "error", provider: hit.provider, reason: res?.error ?? "The confirmation failed" });
      } catch (e: any) {
        setNotice({ kind: "error", provider: hit.provider, reason: e?.message ?? `Couldn't confirm ${name}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read of the landing URL
  }, []);

  const loading = connections.data === undefined && !connections.error;
  const byId = new Map<string, AppConnectionStatus>(
    (connections.data?.apps ?? []).map((a: AppConnectionStatus) => [a.id, a]),
  );

  return (
    <SettingsPanel>
      {notice?.kind === "error" && (
        <SettingsCallout tone="danger">
          {notice.provider ? `${APP_DESCRIPTORS[notice.provider].name}: ` : ""}
          {describeConnectorError(notice.reason)}
        </SettingsCallout>
      )}

      <SettingsSection
        title="Connected services"
        icon={Plug}
        description="Connections belong to your workspace, not to a machine. Tokens stay server-side — an agent asks the backend to act, it never holds the credential."
      >
        {connections.error && (
          <div className="px-4 py-3 sm:px-5">
            <SettingsCallout tone="warning">
              Couldn&apos;t load connection state: {connections.error.message}. The cards below say nothing
              rather than guessing.
            </SettingsCallout>
          </div>
        )}
        {APP_IDS.map((id) => (
          <IntegrationCard
            key={id}
            descriptor={APP_DESCRIPTORS[id]}
            connection={byId.get(id)}
            loading={loading}
            me={me.data}
          />
        ))}
      </SettingsSection>
    </SettingsPanel>
  );
}
