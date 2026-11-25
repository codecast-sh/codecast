"use client";
// The nudge-slot strip for the setup step that matters most right now
// (lib/setupProgress pickSetupNudge): working solo, a team of one, nothing
// shared with the team, agent features off. "Later" snoozes that step, each
// time for longer, so it keeps asking without nagging.

import { useState } from "react";
import { Bot, FolderGit2, UserPlus, Users } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useSetupProgress } from "../../hooks/useSetupProgress";
import { nudgeCountKey, nudgeSnoozeKey, pickSetupNudge, type SetupStep } from "../../lib/setupProgress";
import { openSharingAgentId } from "../../lib/sharingAgent";
import { openConversationBeside } from "../../hooks/useOpenLinkedSession";
import { Button } from "../ui/button";
import { SetupStepAction } from "./SetupStepAction";

const ICON = { team: Users, invite: UserPlus, share_repo: FolderGit2, agents: Bot } as const;

function copyFor(step: SetupStep, team: any | null): { lead: string; rest: string } {
  switch (step.key) {
    case "team":
      return { lead: "You're working solo.", rest: "Start a team so teammates can follow your agents live and pick up where you stop." };
    case "invite":
      return { lead: `${team?.name ?? "Your team"} is just you.`, rest: "Invite a teammate to see each other's sessions, chat and call." };
    case "share_repo":
      return { lead: `Nothing flows to ${team?.name ?? "your team"} yet.`, rest: "Share a repo and teammates see its sessions as they happen." };
    default:
      return { lead: `Agent features: ${step.state}.`, rest: "Turn them on so agents can post to chat, file tasks and bring you decisions." };
  }
}

export function SetupNudgeBanner() {
  const { steps, team, ready } = useSetupProgress();
  const dismissed = useInboxStore((s) => s.clientState.dismissed);
  const agentId = useInboxStore(openSharingAgentId);
  const [mounted, setMounted] = useState(false);
  useMountEffect(() => { setMounted(true); });

  if (!mounted || !ready) return null;
  const step = pickSetupNudge(steps, dismissed);
  if (!step) return null;

  const later = () => {
    const st = useInboxStore.getState();
    const n = Number(dismissed?.[nudgeCountKey(step.key)] ?? 0) + 1;
    st.updateClientDismissed(nudgeCountKey(step.key), n);
    st.updateClientDismissed(nudgeSnoozeKey(step.key), Date.now());
  };
  const Icon = ICON[step.key as keyof typeof ICON] ?? Users;
  // A sharing agent is already on this step: send the person to it, not
  // back to the manual route they left.
  const agent = step.key === "share_repo" ? agentId : null;
  const { lead, rest } = agent
    ? { lead: "An agent is setting up sharing.", rest: "Answer it in its conversation." }
    : copyFor(step, team);

  return (
    <div data-cc-banner data-nudge data-setup-nudge={step.key} className="border-b border-sol-cyan/30 bg-gradient-to-r from-sol-cyan/10 via-sol-cyan/5 to-sol-cyan/10">
      <div className="flex items-center justify-between gap-4 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="h-4 w-4 flex-shrink-0 text-sol-cyan" />
          <span className="truncate text-sm text-sol-text">
            <span className="font-medium">{lead}</span> <span className="text-sol-text-muted">{rest}</span>
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {agent ? (
            <Button variant="cyan" size="xs" data-setup-action={step.key} onClick={() => openConversationBeside(agent)}>
              Open agent
            </Button>
          ) : (
            <SetupStepAction step={step} team={team} look="strip" />
          )}
          <button
            type="button"
            onClick={later}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-sol-text-muted transition-colors hover:text-sol-text"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
