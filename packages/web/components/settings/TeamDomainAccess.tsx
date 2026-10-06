import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { AtSign } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./ui";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { AvatarImg } from "../../lib/avatarCache";

/**
 * Admins only: let people with a proven address at the company's domain find
 * this team and ask to join, and decide the requests (convex/teamDiscovery.ts).
 * Off until an admin turns it on; the domain is the admin's own.
 */
export function TeamDomainAccess({ teamId }: { teamId: Id<"teams"> }) {
  const settings = useQueryNoThrow(api.teamDiscovery.discoverySettings, { team_id: teamId }).data;
  const requests = useQueryNoThrow(api.teamDiscovery.pendingRequests, { team_id: teamId }).data ?? [];
  const setDiscoverable = useMutation(api.teamDiscovery.setDiscoverable);
  const decide = useMutation(api.teamDiscovery.decideRequest);
  const [busy, setBusy] = useState<string | null>(null);
  if (!settings) return null;

  const domain = settings.enabled_domain ?? settings.admin_domain;
  const canOpen = !!settings.admin_domain && settings.admin_domain_proven;
  const toggle = (on: boolean) => {
    setBusy("toggle");
    setDiscoverable({ team_id: teamId, enabled: on })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not change that"))
      .finally(() => setBusy(null));
  };
  const answer = (requestId: Id<"team_join_requests">, approve: boolean, who: string) => {
    setBusy(requestId);
    decide({ request_id: requestId, approve })
      .then(() => toast.success(approve ? `${who} joined the team` : `Declined ${who}`))
      .catch((err) => toast.error(err instanceof Error ? err.message : "Could not do that"))
      .finally(() => setBusy(null));
  };

  return (
    <SettingsSection
      title="Coworkers"
      icon={AtSign}
      description={
        domain
          ? `People who sign in with a verified @${domain} address can find this team and ask to join. You approve each one. Nobody else learns the team exists.`
          : "Your account email is a personal address, so there is no company domain to open the team to. Use invite links instead."
      }
    >
      <SettingsRow
        label={domain ? `Let @${domain} coworkers find this team` : "Let coworkers find this team"}
        description={
          canOpen || settings.enabled_domain
            ? undefined
            : settings.admin_domain
              ? `Confirm you hold your @${settings.admin_domain} address first (sign in with GitHub, Google or Apple, or confirm it from the banner).`
              : undefined
        }
      >
        <Switch
          checked={!!settings.enabled_domain}
          disabled={busy === "toggle" || (!settings.enabled_domain && !canOpen)}
          onCheckedChange={toggle}
          aria-label="Let coworkers find this team"
        />
      </SettingsRow>
      {requests.map((r) => {
        const who = r.name || r.email || "Someone";
        return (
          <SettingsRow
            key={r._id}
            label={who}
            description={`${r.email ?? ""} asked to join`}
          >
            <div className="flex items-center gap-2">
              {r.image && <AvatarImg src={r.image} alt="" className="h-6 w-6 rounded-full" />}
              <Button size="sm" variant="outline" disabled={busy === r._id} onClick={() => answer(r._id, false, who)}>
                Decline
              </Button>
              <Button size="sm" variant="cyan" disabled={busy === r._id} onClick={() => answer(r._id, true, who)}>
                Let in
              </Button>
            </div>
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}
