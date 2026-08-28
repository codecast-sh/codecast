import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { Input } from "../../../../components/ui/input";
import { Label } from "../../../../components/ui/label";
import { TEAM_ICONS, TEAM_COLORS } from "../../../../components/TeamIcon";
import { TeamFlowShell, type TeamFlowStep } from "../../../../components/team/TeamFlowShell";
import { TeamIdentityPicker, type TeamIdentity } from "../../../../components/team/TeamIdentityPicker";
import { VisibilityPicker, type TeamVisibility } from "../../../../components/team/VisibilityPicker";
import { WorkspaceSharePicker } from "../../../../components/team/WorkspaceSharePicker";
import { useWorkspaceSelection } from "../../../../hooks/useWorkspaceSelection";
import { InvitePanel } from "../../../../components/team/InvitePanel";
import { useTeamWorkspaceSuggestions } from "../../../../hooks/useTeamWorkspaceSuggestions";
import { useSaveTeamSetup } from "../../../../lib/team/saveTeamSetup";
import { adoptPathIntoActiveTab } from "../../../../src/compat/tabRouting";
import { useCurrentUser } from "../../../../hooks/useCurrentUser";
import { useInboxStore } from "../../../../store/inboxStore";
import { cn } from "../../../../lib/utils";

const NAME_MAX = 40;
const NAME_FORM_ID = "team-create-name";
const TEAM_FEED_PATH = "/team/activity";

const STEPS: TeamFlowStep[] = [
  { key: "identity", label: "Identity" },
  { key: "visibility", label: "Visibility" },
  { key: "workspaces", label: "Workspaces" },
  { key: "invite", label: "Invite" },
];

function randomPick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * Create team flow. Step 1 writes the team through the store's local-first
 * createTeam action and advances in the same tick. Later steps target the
 * real id once the server answers; they never wait for it to paint.
 */
export default function CreateTeamPage() {
  const router = useRouter();
  const { user } = useCurrentUser();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [identity, setIdentity] = useState<TeamIdentity>(() => ({
    icon: randomPick(TEAM_ICONS),
    color: randomPick(TEAM_COLORS),
  }));
  const [createError, setCreateError] = useState("");
  const [visibility, setVisibility] = useState<TeamVisibility>("full");

  // The real id lands here once the server echoes. Until then the store holds
  // a stub row and the switcher already shows the new team.
  const [teamId, setTeamId] = useState<Id<"teams"> | null>(null);
  const teamIdPromise = useRef<Promise<string> | null>(null);
  // What the server holds after create. A revisit to step 1 diffs against
  // this and patches instead of creating a second team.
  const applied = useRef<{ name: string; icon: string; color: string } | null>(null);
  const alive = useRef(true);
  // Set true in the setup, not only at ref creation: StrictMode's dev
  // mount, unmount, remount cycle runs the cleanup once, and a ref does
  // not reinitialize. Without the setup write, alive stays false and the
  // resolved team id never lands, so steps 3 and 4 load forever.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const renameTeam = useMutation(api.teams.renameTeam);
  const updateTeamIcon = useMutation(api.teams.updateTeamIcon);

  const data = useTeamWorkspaceSuggestions(teamId);
  const { selectedPaths, toggle, selectedCount } = useWorkspaceSelection(data, teamId);
  const save = useSaveTeamSetup();

  const trimmed = name.trim();
  const nameValid = trimmed.length > 0 && trimmed.length <= NAME_MAX;
  const nearNameLimit = trimmed.length >= NAME_MAX - 10;

  const goBack = useCallback(() => {
    if (step === 0) router.push("/settings/team");
    else setStep((s) => s - 1);
  }, [step, router]);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameValid || !user) return;
    setCreateError("");

    // The team already exists: the user came back to fix the identity.
    // Patch the diffs against the real id and move on. Never create twice.
    if (teamIdPromise.current) {
      const prev = applied.current;
      const next = { name: trimmed, icon: identity.icon, color: identity.color };
      applied.current = next;
      if (prev && (prev.name !== next.name || prev.icon !== next.icon || prev.color !== next.color)) {
        teamIdPromise.current
          .then(async (id) => {
            const team_id = id as Id<"teams">;
            if (prev.name !== next.name) await renameTeam({ team_id, name: next.name });
            if (prev.icon !== next.icon || prev.color !== next.color) {
              await updateTeamIcon({
                team_id,
                icon: prev.icon !== next.icon ? next.icon : undefined,
                icon_color: prev.color !== next.color ? next.color : undefined,
              });
            }
          })
          .catch((err) => {
            console.error("Team identity update failed:", err);
            toast.error("Could not update the team identity. You can change it in Settings.");
          });
      }
      setStep(1);
      return;
    }

    applied.current = { name: trimmed, icon: identity.icon, color: identity.color };
    const p = useInboxStore.getState().createTeam({
      name: trimmed,
      icon: identity.icon,
      icon_color: identity.color,
    });
    teamIdPromise.current = p;
    setStep(1);
    p.then(
      (id) => { if (alive.current) setTeamId(id as Id<"teams">); },
      (err: unknown) => {
        if (!alive.current) return;
        teamIdPromise.current = null;
        applied.current = null;
        setStep(0);
        setCreateError(err instanceof Error ? err.message : "Could not create the team. Try again.");
      },
    );
  };

  // Writes visibility and the chosen workspaces once the id is real. The UI
  // moves on right away; a failure surfaces as a toast.
  const finishSetup = (paths: Record<string, boolean>) => {
    setStep(3);
    const p = teamIdPromise.current;
    if (!p) return;
    p.then((id) =>
      save({ teamId: id as Id<"teams">, visibility, selectedPaths: paths, allProjects: data.allProjects }),
    ).catch((err) => {
      console.error("Team setup save failed:", err);
      toast.error("Could not save the team settings. You can change them in Settings.");
    });
  };

  const openTeam = () => {
    // This page lives outside the tab shell. Point the active tab at the
    // feed first, or the shell re-asserts its old path on re-entry and the
    // push lands on whatever the user last had open.
    adoptPathIntoActiveTab(TEAM_FEED_PATH);
    router.push(TEAM_FEED_PATH);
  };

  const crest = { icon: identity.icon, color: identity.color, name: trimmed };

  if (step === 0) {
    return (
      <TeamFlowShell
        eyebrow="New team"
        steps={STEPS}
        stepIndex={0}
        crest={crest}
        heading="Name your team"
        description="Pick a name, an icon and a color. You can change them later."
        onBack={goBack}
        backLabel="Cancel"
        formId={NAME_FORM_ID}
        continueLabel={teamIdPromise.current ? "Save and continue" : "Create team"}
        continueDisabled={!nameValid || !user}
      >
        <form id={NAME_FORM_ID} onSubmit={create} className="space-y-6">
          <div>
            <div className="flex items-baseline justify-between">
              <Label htmlFor="teamName" className="text-sol-text">Team name</Label>
              {/* The live region exists only while the counter is shown.
                  opacity alone keeps it in the accessibility tree, which
                  would announce the count on every keystroke from the first
                  character. */}
              <span
                className={cn(
                  "text-xs tabular-nums transition-opacity",
                  nearNameLimit ? "opacity-100" : "opacity-0",
                  trimmed.length > NAME_MAX ? "text-sol-red" : "text-sol-text-dim",
                )}
                aria-live={nearNameLimit ? "polite" : undefined}
                aria-hidden={nearNameLimit ? undefined : true}
              >
                {trimmed.length}/{NAME_MAX}
              </span>
            </div>
            <Input
              id="teamName"
              value={name}
              onChange={(e) => { setName(e.target.value); if (createError) setCreateError(""); }}
              placeholder="Acme Robotics"
              maxLength={NAME_MAX + 20}
              autoFocus
              autoComplete="off"
              aria-invalid={trimmed.length > NAME_MAX || undefined}
              className="mt-1.5 h-11 text-base bg-sol-bg-alt border-sol-border text-sol-text focus-visible:ring-[var(--team-flow-accent)]"
            />
            {trimmed.length > NAME_MAX && (
              <p className="mt-1.5 text-xs text-sol-red">Use {NAME_MAX} characters or fewer.</p>
            )}
          </div>

          <TeamIdentityPicker value={identity} onChange={setIdentity} previewName={name} />

          {createError && (
            <div role="alert" className="p-3 bg-sol-red/10 border border-sol-red/20 rounded-lg">
              <p className="text-sm text-sol-red">{createError}</p>
            </div>
          )}
        </form>
      </TeamFlowShell>
    );
  }

  if (step === 1) {
    return (
      <TeamFlowShell
        eyebrow="New team"
        steps={STEPS}
        stepIndex={1}
        crest={crest}
        heading="What teammates see"
        description="Choose how much of your work shows in the team feed. You can change this any time."
        onBack={goBack}
        onSkip={() => setStep(2)}
        skipLabel="Keep full access"
        onContinue={() => setStep(2)}
        enterAdvances
      >
        <VisibilityPicker value={visibility} onChange={setVisibility} />
      </TeamFlowShell>
    );
  }

  if (step === 2) {
    return (
      <TeamFlowShell
        eyebrow="New team"
        steps={STEPS}
        stepIndex={2}
        crest={crest}
        heading="Where the team works"
        description="Pick the repos this team works in. Sessions there show in the team feed."
        onBack={goBack}
        onSkip={() => finishSetup({})}
        skipLabel="Skip for now"
        onContinue={() => finishSetup(selectedPaths)}
        continueLabel={selectedCount > 0 ? `Share ${selectedCount} workspace${selectedCount === 1 ? "" : "s"}` : "Continue"}
        enterAdvances
      >
        <WorkspaceSharePicker
          data={data}
          teamId={teamId}
          selectedPaths={selectedPaths}
          onToggle={toggle}
          isNewTeam
        />
      </TeamFlowShell>
    );
  }

  return (
    <TeamFlowShell
      eyebrow="New team"
      steps={STEPS}
      stepIndex={3}
      crest={crest}
      heading="Invite your first teammate"
      description="Share the link or send an email. Anyone who opens it joins this team."
      onBack={goBack}
      onContinue={openTeam}
      continueLabel="Open team"
      enterAdvances
    >
      {teamId ? (
        <InvitePanel teamId={teamId} variant="page" />
      ) : (
        <div className="space-y-3" aria-busy="true">
          <div className="h-4 w-28 rounded bg-sol-bg-alt animate-pulse" />
          <div className="h-11 rounded-md bg-sol-bg-alt animate-pulse" />
          <p className="text-sm text-sol-text-dim">Preparing the invite link.</p>
        </div>
      )}
    </TeamFlowShell>
  );
}
