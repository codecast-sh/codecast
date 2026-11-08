"use client";
/**
 * Set up an existing team: the setup flow's Features and Agents steps for a
 * team made before new teams started with every feature on. Nothing turns on
 * by itself here; each switch starts where the team left it and an admin
 * flips what they want. Finishing records every feature still undecided as
 * off, so the team is never offered them again (tours/guides/FeatureOfferAnywhere).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { undecidedSetupFeatures } from "@codecast/shared/contracts";
import { TeamFlowShell, type TeamFlowStep } from "../../../../components/team/TeamFlowShell";
import { FeatureStep } from "../../../../components/onboarding/FeatureStep";
import { ConnectStep } from "../../../../components/onboarding/ConnectStep";
import { useAgentFeatureChoice } from "../../../../hooks/useAgentFeatureChoice";
import { useSetupFeatures } from "../../../../hooks/useSetupFeatures";
import { useInboxStore } from "../../../../store/inboxStore";
import { activeTeamIdOf } from "../../../../lib/activeTeam";
import "../../../../components/onboarding/onboarding.css";

const STEPS: TeamFlowStep[] = [
  { key: "features", label: "Features" },
  { key: "agents", label: "Agents" },
];

export default function TeamFeaturesSetupPage() {
  const router = useRouter();
  const team = useInboxStore((s) => {
    const id = activeTeamIdOf(s);
    return id ? (s.teams || []).find((t: any) => t && String(t._id) === id) : undefined;
  }) as any;
  const [step, setStep] = useState(0);
  const agents = useAgentFeatureChoice();
  const admin = team?.role === "admin" || team?.role === "owner";
  const teamId = team && admin ? String(team._id) : null;
  const features = useSetupFeatures(teamId);

  const finish = (all = false) => {
    agents.commit(all);
    const st = useInboxStore.getState();
    if (teamId) for (const f of undecidedSetupFeatures(team)) st.setTeamFeature(teamId, f.key, false);
    router.push("/inbox");
    if (team) toast(`${team.name} is set up`);
  };

  const shell = {
    eyebrow: "Team setup",
    crest: { icon: team?.icon, color: team?.icon_color, name: team?.name ?? "" },
    steps: STEPS,
    stepIndex: step,
    visitedIndex: step,
    onStepSelect: (i: number) => setStep(i),
  };

  if (step === 0) {
    return (
      <TeamFlowShell
        {...shell}
        heading={team ? `Everything ${team.name} can have` : "Everything your team can have"}
        description={admin ? "Each one works for people and agents alike, for everyone on the team." : "Only a team admin can turn these on."}
        onBack={() => router.back()}
        backLabel="Cancel"
        onSkip={admin && !features.allOn ? () => setStep(1) : undefined}
        skipLabel={`Continue with ${features.onCount}`}
        onContinue={() => { features.turnAllOn(); setStep(1); }}
        continueLabel={admin && !features.allOn ? `Turn on all ${features.total}` : "Continue"}
        enterAdvances
      >
        <FeatureStep teamId={teamId} />
      </TeamFlowShell>
    );
  }

  return (
    <TeamFlowShell
      {...shell}
      heading="Connect your agents"
      description="Agents learn to use everything you just turned on."
      onBack={() => setStep(0)}
      onSkip={agents.allChosen ? undefined : () => finish()}
      skipLabel={`Finish with ${agents.chosen.size}`}
      onContinue={() => finish(true)}
      continueLabel={agents.allChosen ? "Finish" : `Turn on all ${agents.total}`}
      enterAdvances
    >
      <ConnectStep choice={agents} />
    </TeamFlowShell>
  );
}
