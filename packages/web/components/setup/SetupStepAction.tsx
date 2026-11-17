"use client";
// The one press that finishes a setup step (lib/setupProgress), shared by the
// sidebar checklist and the nudge strip so a step does the same thing from
// either place. Presses that hand agents a capability or widen what others
// read go through the shared review (components/consequential).

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../../store/inboxStore";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { InvitePanel } from "../team/InvitePanel";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { featuresAllLedger, shareInFullLedger } from "../consequential/ledgers";
import { useAgentFeatureChoice, useAvailableAgentFeatures } from "../../hooks/useAgentFeatureChoice";
import { useSetupFeatures } from "../../hooks/useSetupFeatures";
import { useOsPermission } from "../../hooks/useOsPermissions";
import { requestOsPermission } from "../../lib/osPermissions";
import { teamVisibilityOption } from "../../lib/teamVisibility";
import { NATIVE_APP_LINKS, trackNativeAppClick } from "../../lib/nativeApps";
import { deviceDisplayName, useDevices } from "../DeviceBadge";
import type { SetupStep } from "../../lib/setupProgress";

type Props = {
  step: SetupStep;
  team: any | null;
  /** "strip" is the nudge banner's primary button; "row" the checklist's. */
  look?: "strip" | "row";
  /** Called once the press has done its part (navigated, confirmed, opened). */
  onAct?: () => void;
};

const STEP_CTA: Record<SetupStep["key"], string> = {
  connect: "Connect",
  team: "Start a team",
  invite: "Invite",
  share_repo: "Choose repos",
  share_full: "Share in full",
  agents: "Turn on all",
  notifications: "Turn on",
  team_features: "Turn on all",
  desktop: "Download",
};

export function SetupStepAction({ step, team, look = "row", onAct }: Props) {
  const label = STEP_CTA[step.key];
  const size = "xs" as const;
  const variant = look === "strip" ? ("cyan" as const) : ("outline" as const);
  const link = (href: string, extra?: () => void) => (
    <Button asChild variant={variant} size={size} data-setup-action={step.key}>
      <Link href={href} onClick={() => { extra?.(); onAct?.(); }}>{label}</Link>
    </Button>
  );

  switch (step.key) {
    case "connect":
      return link("/settings/cli");
    case "team":
      return link("/settings/team/create");
    case "share_repo":
      return link("/settings/sync");
    case "desktop":
      return (
        <Button asChild variant={variant} size={size} data-setup-action="desktop">
          <a href={NATIVE_APP_LINKS.mac} onClick={() => { trackNativeAppClick("mac", "setup"); onAct?.(); }}>{label}</a>
        </Button>
      );
    case "invite":
      return team ? <InviteAction teamId={team._id} teamName={team.name} variant={variant} label={label} onAct={onAct} /> : null;
    case "share_full":
      return team ? <ShareFullAction team={team} variant={variant} label={label} onAct={onAct} /> : null;
    case "agents":
      return <AgentsAction variant={variant} label={label} onAct={onAct} />;
    case "notifications":
      return <NotificationsAction variant={variant} label={label} onAct={onAct} />;
    case "team_features":
      return team ? <TeamFeaturesAction teamId={String(team._id)} teamName={team.name} variant={variant} label={label} onAct={onAct} /> : null;
  }
}

type ActionProps = { variant: "cyan" | "outline"; label: string; onAct?: () => void };

function InviteAction({ teamId, teamName, variant, label, onAct }: ActionProps & { teamId: Id<"teams">; teamName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size="xs" onClick={() => setOpen(true)} data-setup-action="invite">{label}</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) onAct?.(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Invite to {teamName}</DialogTitle>
          </DialogHeader>
          <InvitePanel teamId={teamId} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function ShareFullAction({ team, variant, label, onAct }: ActionProps & { team: any }) {
  const setVisibility = useInboxStore((s) => s.setTeamMembershipVisibility);
  const others = Math.max(1, (team.member_count ?? 2) - 1);
  return (
    <ConsequentialSwitch
      on={false}
      ledger={shareInFullLedger({ team: team.name, others, sees: teamVisibilityOption(team.visibility).sees })}
      onTurnOn={() => {
        setVisibility(String(team._id), "full", "going_forward");
        toast.success(`${team.name} sees whole conversations for new sessions`);
        onAct?.();
      }}
      onTurnOff={() => {}}
      trigger={({ press, reviewing }) => (
        <Button variant={variant} size="xs" onClick={press} aria-haspopup="dialog" aria-expanded={reviewing} data-setup-action="share_full">{label}</Button>
      )}
    />
  );
}

function AgentsAction({ variant, label, onAct }: ActionProps) {
  const choice = useAgentFeatureChoice();
  const features = useAvailableAgentFeatures();
  const { onlineLocals } = useDevices();
  const machine = onlineLocals.length === 0
    ? "Next machine to connect"
    : onlineLocals.length === 1 ? deviceDisplayName(onlineLocals[0]) : `${onlineLocals.length} machines`;
  return (
    <ConsequentialSwitch
      on={false}
      ledger={featuresAllLedger({ group: "Agent", machine, names: features.map((f) => f.name) })}
      onTurnOn={() => {
        choice.commit(true);
        toast.success(onlineLocals.length ? `Agent features on for ${machine}` : "Agent features turn on when your computer connects");
        onAct?.();
      }}
      onTurnOff={() => {}}
      trigger={({ press, reviewing }) => (
        <Button variant={variant} size="xs" onClick={press} aria-haspopup="dialog" aria-expanded={reviewing} data-setup-action="agents">{label}</Button>
      )}
    />
  );
}

function NotificationsAction({ variant, label, onAct }: ActionProps) {
  const { readiness, refresh } = useOsPermission("notifications");
  return (
    <Button
      variant={variant}
      size="xs"
      data-setup-action="notifications"
      onClick={async () => {
        await requestOsPermission("notifications", readiness);
        refresh();
        onAct?.();
      }}
    >
      {readiness === "off" ? "Open settings" : label}
    </Button>
  );
}

function TeamFeaturesAction({ teamId, teamName, variant, label, onAct }: ActionProps & { teamId: string; teamName: string }) {
  const features = useSetupFeatures(teamId);
  return (
    <ConsequentialSwitch
      on={false}
      ledger={featuresAllLedger({
        group: "Team",
        machine: teamName,
        names: features.off.map((f) => `${f.name} · ${f.short}`),
        appliesTo: `Everyone in ${teamName}`,
      })}
      onTurnOn={() => {
        const names = features.off.map((f) => f.name).join(", ");
        features.turnAllOn();
        toast.success(`Turned on ${names} for ${teamName}`);
        onAct?.();
      }}
      onTurnOff={() => {}}
      trigger={({ press, reviewing }) => (
        <Button variant={variant} size="xs" onClick={press} aria-haspopup="dialog" aria-expanded={reviewing} data-setup-action="team_features">{label}</Button>
      )}
    />
  );
}
