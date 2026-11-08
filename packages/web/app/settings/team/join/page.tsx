import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { joinErrorText } from "../../../../lib/team/joinError";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { Users } from "lucide-react";
import { Input } from "../../../../components/ui/input";
import { Button } from "../../../../components/ui/button";
import { Label } from "../../../../components/ui/label";
import { TeamFlowShell, type TeamFlowStep } from "../../../../components/team/TeamFlowShell";
import { VisibilityPicker, type TeamVisibility } from "../../../../components/team/VisibilityPicker";
import { WorkspaceSharePicker } from "../../../../components/team/WorkspaceSharePicker";
import { useWorkspaceSelection } from "../../../../hooks/useWorkspaceSelection";
import { useTeamWorkspaceSuggestions } from "../../../../hooks/useTeamWorkspaceSuggestions";
import { useSaveTeamSetup } from "../../../../lib/team/saveTeamSetup";
import { useSwitchWorkspace } from "../../../../hooks/useSwitchWorkspace";
import { useShareImpact } from "../../../../hooks/useShareImpact";
import { shareActionLabel } from "../../../../lib/team/shareImpact";
import { useCurrentUser } from "../../../../hooks/useCurrentUser";
import { useInboxStore } from "../../../../store/inboxStore";
import { ConnectStep } from "../../../../components/onboarding/ConnectStep";
import { useAgentFeatureChoice } from "../../../../hooks/useAgentFeatureChoice";

import { useWatchEffect } from "../../../../hooks/useWatchEffect";
const CODE_FORM_ID = "team-join-code";
const CODE_LENGTH = 8;
const TEAM_FEED_PATH = "/team/activity";

const STEPS: TeamFlowStep[] = [
  { key: "code", label: "Invite code" },
  { key: "agents", label: "Agents" },
  { key: "sharing", label: "Sharing" },
];

/**
 * Join team flow. The code step joins for real; the Agents and Sharing steps
 * are the setup flow's own (components/onboarding), so a joiner connects
 * their machine with every agent feature on and shares their repos the same
 * way a creator does. The public /join/<code> landing hands off here with
 * ?teamId= once it has joined, skipping the code step. An existing member
 * tuning their sharing (?setup=1) sees only Sharing.
 */
export default function JoinTeamPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useCurrentUser();
  const joinTeam = useMutation(api.teams.joinTeam);
  const switchWorkspace = useSwitchWorkspace();

  // A hand-off from /join/<code> arrives already joined: start at
  // visibility with the code step done. `setup=1` marks an existing member
  // tuning their sharing (e.g. from the team feed nudge), not a fresh join.
  const [teamId, setTeamId] = useState<Id<"teams"> | null>(
    () => (searchParams.get("teamId") as Id<"teams"> | null) || null,
  );
  const isSetup = searchParams.get("setup") === "1";
  const [step, setStep] = useState(() => (isSetup ? 2 : searchParams.get("teamId") ? 1 : 0));
  const agents = useAgentFeatureChoice();
  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState("");
  const [visibility, setVisibility] = useState<TeamVisibility>("full");

  // A full code previews the team before joining: the crest becomes the
  // rail's hero and the button names the team it is about to join.
  const code = inviteCode.trim().toUpperCase();
  // Stays subscribed after the join: it bridges the crest until the
  // suggestions query answers for the just-joined team.
  const preview = useQuery(
    api.teams.getTeamByInviteCode,
    code.length === CODE_LENGTH ? { invite_code: code } : "skip",
  );
  const previewExpired = !!preview?.isExpired;

  const data = useTeamWorkspaceSuggestions(teamId);
  const { selectedPaths, toggle, selectedList, since, setSince } = useWorkspaceSelection(data, teamId);
  const impact = useShareImpact(selectedList, data.allProjects, since);
  const save = useSaveTeamSetup();

  // The member's default visibility on this team lands with the
  // suggestions; seed the picker once it does.
  useWatchEffect(() => {
    const current = data.suggestions?.current_visibility;
    if (current) setVisibility(current);
  }, [data.suggestions?.team_id, data.suggestions?.current_visibility]);

  // The suggestions query is the slowest source of the team's identity. The
  // code step's preview and the store's team row (already synced for the
  // handoff and setup entries) cover the gap, so the crest never shows the
  // placeholder while the team is already known.
  const previewOk = preview && !previewExpired ? preview : null;
  const storeTeam = useInboxStore((s) => s.teams)?.find(
    (t) => t?._id?.toString() === teamId?.toString(),
  );
  const teamName =
    (data.teamName !== "your team" ? data.teamName : previewOk?.name ?? storeTeam?.name) || "";
  const crest = teamId
    ? {
        icon: data.suggestions?.team_icon ?? previewOk?.icon ?? storeTeam?.icon,
        color: data.suggestions?.team_icon_color ?? previewOk?.icon_color ?? storeTeam?.icon_color,
        name: teamName,
      }
    : previewOk
      ? { icon: previewOk.icon, color: previewOk.icon_color, name: previewOk.name }
      : { name: "" };

  const goBack = useCallback(() => {
    if (step === 0 || step === 1 || isSetup) {
      // Before joining, leaving is a cancel. Once joined, the membership is
      // real and Agents is the first step, so back exits the flow too;
      // everything here can be changed later in Settings.
      router.push("/settings/team");
      return;
    }
    setStep((s) => s - 1);
  }, [step, router, isSetup]);

  const handleJoinTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== CODE_LENGTH || !user?._id || previewExpired) return;
    setJoining(true);
    setError("");
    try {
      const id = await joinTeam({ invite_code: code });
      // Joining IS the switch: the rest of the flow tunes the new team, and
      // an abandoned flow still leaves the user in the team they joined.
      void switchWorkspace(id);
      setTeamId(id as Id<"teams">);
      setStep(1);
    } catch (err) {
      setError(joinErrorText(err));
    } finally {
      setJoining(false);
    }
  };

  const handlePasteLink = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const match = text.match(/\/join\/([A-Z0-9]+)/i);
      if (match) {
        setInviteCode(match[1].toUpperCase());
      } else if (/^[A-Z0-9]{8}$/i.test(text.trim())) {
        setInviteCode(text.trim().toUpperCase());
      }
    } catch {
      // Clipboard access denied
    }
  };

  // Saves ride behind the navigation: the feed opens now, the mappings
  // confirm (or fail) in their own toast.
  const finishSetup = (paths: Record<string, boolean>) => {
    const id = teamId;
    const name = teamName || "the team";
    if (id) {
      save({ teamId: id, visibility, selectedPaths: paths, allProjects: data.allProjects, shareSince: since })
        .then(({ mapped }) => {
          if (mapped > 0) toast.success(`Sharing ${mapped} workspace${mapped === 1 ? "" : "s"} with ${name}`);
        })
        .catch((err) => {
          console.error("Team setup save failed:", err);
          toast.error("Could not save the team settings", { description: "You can change them in Settings." });
        });
    }
    useInboxStore.getState().updateClientUI({ setup_done_at: Date.now() });
    router.push(TEAM_FEED_PATH);
    toast.success(isSetup ? `Saved your ${name} setup` : `Welcome to ${name}`, {
      description: "This is its feed. Sessions from shared workspaces land here.",
    });
  };

  // The rail already names the team under its crest.
  const laterEyebrow = isSetup ? "Team setup" : "Joined";
  // An existing member tuning sharing never sees the code or agents step, so
  // the rail shows only the step they can actually visit.
  const steps = isSetup ? STEPS.slice(2) : STEPS;
  const stepOffset = isSetup ? 2 : 0;

  if (step === 0) {
    return (
      <TeamFlowShell
        eyebrow="Join a team"
        steps={STEPS}
        stepIndex={0}
        crest={crest}
        heading="Enter the invite code"
        description="Type the 8 character code or paste the invite link."
        onBack={goBack}
        backLabel="Cancel"
        formId={CODE_FORM_ID}
        continueLabel={
          joining ? "Joining" : preview && !previewExpired ? `Join ${preview.name}` : "Join team"
        }
        continueDisabled={code.length !== CODE_LENGTH || joining || !user || previewExpired}
      >
        <form id={CODE_FORM_ID} onSubmit={handleJoinTeam} className="space-y-5">
          <div>
            <Label htmlFor="inviteCode" className="text-sol-text">Invite code</Label>
            <div className="flex gap-2 mt-1.5">
              <Input
                id="inviteCode"
                value={inviteCode}
                onChange={(e) => { setInviteCode(e.target.value.toUpperCase()); if (error) setError(""); }}
                placeholder="ABCD1234"
                className="h-11 text-base bg-sol-bg-alt border-sol-border text-sol-text font-mono uppercase tracking-[0.2em] focus-visible:ring-[var(--team-flow-accent)]"
                maxLength={CODE_LENGTH}
                autoFocus
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                onClick={handlePasteLink}
                className="h-11 border-sol-border text-sol-text-dim shrink-0"
              >
                Paste
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-sol-text-dim">
              Ask a team admin for the code or link.
            </p>
          </div>

          {preview && !previewExpired && (
            <p className="flex items-center gap-1.5 text-sm text-sol-text-muted" aria-live="polite">
              <Users className="h-3.5 w-3.5" />
              {preview.name} has {preview.memberCount} {preview.memberCount === 1 ? "member" : "members"}
            </p>
          )}
          {previewExpired && (
            <div role="alert" className="p-3 bg-sol-red/10 border border-sol-red/20 rounded-lg">
              <p className="text-sm text-sol-red">This invite code has expired. Ask a team admin for a new one.</p>
            </div>
          )}
          {error && (
            <div role="alert" className="p-3 bg-sol-red/10 border border-sol-red/20 rounded-lg">
              <p className="text-sm text-sol-red">{error}</p>
            </div>
          )}
        </form>
      </TeamFlowShell>
    );
  }

  if (step === 1) {
    return (
      <TeamFlowShell
        eyebrow={laterEyebrow}
        steps={steps}
        stepIndex={1}
        crest={crest}
        heading="Connect your agents"
        description={`Sessions from this computer sync, and agents learn chat, tasks and everything else ${teamName || "the team"} has on.`}
        onBack={goBack}
        backLabel="Set up later"
        onSkip={agents.allChosen ? undefined : () => { agents.commit(); setStep(2); }}
        skipLabel={`Continue with ${agents.chosen.size}`}
        onContinue={() => { agents.commit(true); setStep(2); }}
        continueLabel={agents.allChosen ? "Continue" : `Turn on all ${agents.total}`}
        enterAdvances
      >
        <ConnectStep choice={agents} />
      </TeamFlowShell>
    );
  }

  return (
    <TeamFlowShell
      eyebrow={laterEyebrow}
      steps={steps}
      stepIndex={2 - stepOffset}
      crest={crest}
      heading="What teammates see"
      description="Pick the repos you work in with this team and how much of your work shows in its feed."
      onBack={goBack}
      onSkip={() => finishSetup({})}
      skipLabel="Skip for now"
      onContinue={() => finishSetup(selectedPaths)}
      continueLabel={shareActionLabel(impact, since) ?? "Open team"}
      enterAdvances
    >
      <div className="space-y-6">
      <VisibilityPicker value={visibility} onChange={setVisibility} compact />
      <WorkspaceSharePicker
        data={data}
        teamId={teamId}
        selectedPaths={selectedPaths}
        onToggle={toggle}
        impact={{
          teamName: teamName || "The team",
          memberCount: storeTeam?.member_count ?? previewOk?.memberCount,
          visibility,
          since,
          onSinceChange: setSince,
        }}
      />
      </div>
    </TeamFlowShell>
  );
}
