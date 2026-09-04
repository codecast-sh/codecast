import { useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
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
import { adoptPathIntoActiveTab } from "../../../../src/compat/tabRouting";
import { useCurrentUser } from "../../../../hooks/useCurrentUser";
import { useInboxStore } from "../../../../store/inboxStore";

import { useWatchEffect } from "../../../../hooks/useWatchEffect";
const CODE_FORM_ID = "team-join-code";
const CODE_LENGTH = 8;
const TEAM_FEED_PATH = "/team/activity";

const STEPS: TeamFlowStep[] = [
  { key: "code", label: "Invite code" },
  { key: "visibility", label: "Visibility" },
  { key: "workspaces", label: "Workspaces" },
];

/**
 * Join team flow. The code step joins for real; visibility and workspaces
 * continue inline in the same shell, so a joiner gets the same guided push
 * to share their repos as a creator does. The public /join/<code> landing
 * hands off here with ?teamId= once it has joined, skipping the code step.
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
  const [step, setStep] = useState(() => (searchParams.get("teamId") ? 1 : 0));
  const isSetup = searchParams.get("setup") === "1";
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
  const { selectedPaths, toggle, selectedCount } = useWorkspaceSelection(data, teamId);
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
    if (step === 0 || step === 1) {
      // Before joining, leaving is a cancel. Once joined, the membership is
      // real and visibility is the first step, so back exits the flow too;
      // everything here can be changed later in Settings.
      router.push("/settings/team");
      return;
    }
    setStep((s) => s - 1);
  }, [step, router]);

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
      setError(err instanceof Error ? err.message : "Could not join the team. Try again.");
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
      save({ teamId: id, visibility, selectedPaths: paths, allProjects: data.allProjects })
        .then(({ mapped }) => {
          if (mapped > 0) toast.success(`Sharing ${mapped} workspace${mapped === 1 ? "" : "s"} with ${name}`);
        })
        .catch((err) => {
          console.error("Team setup save failed:", err);
          toast.error("Could not save the team settings. You can change them in Settings.");
        });
    }
    // This page lives outside the tab shell. Point the active tab at the
    // feed first, or the shell re-asserts its old path on re-entry.
    adoptPathIntoActiveTab(TEAM_FEED_PATH);
    router.push(TEAM_FEED_PATH);
    toast.success(isSetup ? `Saved your ${name} setup` : `Welcome to ${name}`, {
      description: "This is its feed. Sessions from shared workspaces land here.",
    });
  };

  const laterEyebrow = isSetup
    ? teamName ? `Set up ${teamName}` : "Team setup"
    : teamName ? `Welcome to ${teamName}` : "Welcome";
  // An existing member tuning sharing never sees the code step, so the rail
  // shows only the two steps they can actually visit.
  const steps = isSetup ? STEPS.slice(1) : STEPS;
  const stepOffset = isSetup ? 1 : 0;

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
        stepIndex={1 - stepOffset}
        crest={crest}
        heading="What teammates see"
        description={
          isSetup
            ? "Choose how much of your work shows in the team feed. You can change this any time."
            : "You're on the team; the rest is optional tuning. Choose how much of your work shows in the team feed. You can change this any time."
        }
        onBack={goBack}
        backLabel="Set up later"
        onContinue={() => setStep(2)}
        enterAdvances
      >
        <VisibilityPicker value={visibility} onChange={setVisibility} />
      </TeamFlowShell>
    );
  }

  return (
    <TeamFlowShell
      eyebrow={laterEyebrow}
      steps={steps}
      stepIndex={2 - stepOffset}
      crest={crest}
      heading="Where you work"
      description="Pick the repos you work in with this team. Sessions there show in the team feed."
      onBack={goBack}
      onSkip={() => finishSetup({})}
      skipLabel="Skip for now"
      onContinue={() => finishSetup(selectedPaths)}
      continueLabel={selectedCount > 0 ? `Share ${selectedCount} workspace${selectedCount === 1 ? "" : "s"}` : "Open team"}
      enterAdvances
    >
      <WorkspaceSharePicker
        data={data}
        teamId={teamId}
        selectedPaths={selectedPaths}
        onToggle={toggle}
      />
    </TeamFlowShell>
  );
}
