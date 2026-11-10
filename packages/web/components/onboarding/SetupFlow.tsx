"use client";
/**
 * The one setup flow: a new person's first run (/start) and every later
 * "Create team" (/settings/team/create) walk the same steps.
 *
 *   Team      name, icon, color; coworkers at the work domain can find it
 *   Features  chat, calls, tasks, org, flows, ship: a card each, all on
 *   Agents    connect this computer, every agent feature on
 *   Sharing   what teammates see, and which repos feed the team
 *   Invite    a link or an email
 *
 * Step 1 writes the team through the store's local-first createTeam and
 * advances in the same tick; later steps target the real id once the server
 * answers and never wait for it to paint. On /start, "Just me for now"
 * skips the team: the person connects their machine and lands in the inbox.
 */
import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { humanizeConvexError } from "@codecast/shared/contracts";
import { Input } from "../ui/input";
import { api } from "@codecast/convex/convex/_generated/api";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { TEAM_ICONS, TEAM_COLORS } from "../TeamIcon";
import { TeamFlowShell, type TeamFlowStep } from "../team/TeamFlowShell";
import { TeamCrest } from "../team/TeamCrest";
import { TeamIdentityPicker, type TeamIdentity } from "../team/TeamIdentityPicker";
import { VisibilityPicker, type TeamVisibility } from "../team/VisibilityPicker";
import { WorkspaceSharePicker } from "../team/WorkspaceSharePicker";
import { InvitePanel } from "../team/InvitePanel";
import { useWorkspaceSelection } from "../../hooks/useWorkspaceSelection";
import { useShareImpact } from "../../hooks/useShareImpact";
import { shareActionLabel } from "../../lib/team/shareImpact";
import { useTeamWorkspaceSuggestions } from "../../hooks/useTeamWorkspaceSuggestions";
import { useSaveTeamSetup } from "../../lib/team/saveTeamSetup";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useInboxStore } from "../../store/inboxStore";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { cn } from "../../lib/utils";
import { FeatureStep } from "./FeatureStep";
import { ConnectStep } from "./ConnectStep";
import { useAgentFeatureChoice } from "../../hooks/useAgentFeatureChoice";
import { useSetupFeatures } from "../../hooks/useSetupFeatures";
import { DomainTeams } from "./DomainTeams";
import "./onboarding.css";

const NAME_MAX = 40;
const NAME_FORM_ID = "setup-team-name";

type StepKey = "team" | "features" | "agents" | "sharing" | "invite";

const STEP_LABELS: Record<StepKey, string> = {
  team: "Team",
  features: "Features",
  agents: "Agents",
  sharing: "Sharing",
  invite: "Invite",
};

function randomPick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export type SetupFlowMode = "welcome" | "create";

export function SetupFlow({ mode }: { mode: SetupFlowMode }) {
  const router = useRouter();
  const { user } = useCurrentUser();
  const welcome = mode === "welcome";

  const [solo, setSolo] = useState(false);
  const keys: StepKey[] = solo ? ["team", "agents"] : ["team", "features", "agents", "sharing", "invite"];
  const steps: TeamFlowStep[] = keys.map((k) => ({ key: k, label: STEP_LABELS[k] }));

  const [step, setStep] = useState(0);
  // Highest step reached. The rail marks every step up to it as done, so a
  // jump back never demotes the steps the user has already seen.
  const [maxVisited, setMaxVisited] = useState(0);
  const key = keys[Math.min(step, keys.length - 1)];

  const [name, setName] = useState("");
  // On by default for a creator with a proven work domain: teams form on day
  // one, and this is how a coworker who signs up alone finds this one.
  const [findable, setFindable] = useState(true);
  const workDomain = useQueryNoThrow(api.teamDiscovery.myWorkDomain, {}).data;
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
  // Where a revisit to step 1 came from. Back and save both return there,
  // so a trip back to fix the name never re-walks the middle steps.
  const returnTo = useRef(1);
  const alive = useRef(true);
  // Set true in the setup, not only at ref creation: StrictMode's dev
  // mount, unmount, remount cycle runs the cleanup once, and a ref does
  // not reinitialize.
  useMountEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  });

  useWatchEffect(() => {
    setMaxVisited((m) => Math.max(m, step));
  }, [step]);

  const renameTeam = useInboxStore((s) => s.renameTeam);
  const updateTeamIcon = useInboxStore((s) => s.updateTeamIcon);

  const data = useTeamWorkspaceSuggestions(teamId);
  const { selectedPaths, toggle, selectedCount, selectedList, since, setSince } = useWorkspaceSelection(data, teamId);
  const impact = useShareImpact(selectedList, data.allProjects, since);
  const save = useSaveTeamSetup();

  const agents = useAgentFeatureChoice();
  const features = useSetupFeatures(teamId);

  const trimmed = name.trim();
  const nameValid = trimmed.length > 0 && trimmed.length <= NAME_MAX;
  const nearNameLimit = trimmed.length >= NAME_MAX - 10;
  const created = !!teamIdPromise.current;

  const go = (i: number) => setStep(i);
  const indexOf = (k: StepKey) => keys.indexOf(k);

  const finish = () => {
    useInboxStore.getState().updateClientUI({ setup_done_at: Date.now() });
    if (solo || !created) {
      router.push("/inbox");
      return;
    }
    router.push(welcome ? "/inbox" : "/team/activity");
    const teamName = applied.current?.name || trimmed;
    toast(`${teamName} is ready`, {
      icon: <TeamCrest icon={identity.icon} color={identity.color} size="md" tone="strong" />,
      description: "Sessions from shared repos land in the team feed.",
    });
  };

  const goBack = useCallback(() => {
    if (step === 0) {
      // Before create, leaving is a cancel. After create the team is real,
      // so back returns to the step the user came from.
      if (teamIdPromise.current) setStep(returnTo.current);
      else if (!welcome) router.push("/settings/team");
      return;
    }
    if (step === 1) returnTo.current = 1;
    if (solo && step === 1) {
      // Back out of "Just me": the team steps start unvisited again.
      setSolo(false);
      setStep(0);
      setMaxVisited(0);
      return;
    }
    setStep((s) => s - 1);
  }, [step, router, solo, welcome]);

  // On a revisit to step 1 the team already exists. Patch the diffs against
  // the real id. Never create twice.
  const saveIdentityEdits = useCallback(() => {
    const prev = applied.current;
    const next = { name: trimmed, icon: identity.icon, color: identity.color };
    applied.current = next;
    if (!prev || (prev.name === next.name && prev.icon === next.icon && prev.color === next.color)) return;
    teamIdPromise.current
      ?.then(async (id) => {
        if (prev.name !== next.name) await renameTeam(id, next.name);
        if (prev.icon !== next.icon || prev.color !== next.color) {
          await updateTeamIcon(id, {
            icon: prev.icon !== next.icon ? next.icon : undefined,
            icon_color: prev.color !== next.color ? next.color : undefined,
          });
        }
      })
      .catch((err) => {
        console.error("Team identity update failed:", err);
        toast.error("Could not update the team identity", { description: "You can change it in Settings." });
      });
  }, [trimmed, identity, renameTeam, updateTeamIcon]);

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameValid || !user) return;
    setCreateError("");
    setSolo(false);

    if (teamIdPromise.current) {
      saveIdentityEdits();
      setStep(returnTo.current);
      return;
    }

    applied.current = { name: trimmed, icon: identity.icon, color: identity.color };
    const p = useInboxStore.getState().createTeam({
      name: trimmed,
      icon: identity.icon,
      icon_color: identity.color,
      discoverable: !!workDomain?.proven && findable,
    });
    teamIdPromise.current = p;
    setStep(1);
    p.then(
      (id) => { if (alive.current) setTeamId(id as Id<"teams">); },
      (err: unknown) => {
        teamIdPromise.current = null;
        applied.current = null;
        const message = humanizeConvexError(err, "Could not create the team. Try again.");
        if (!alive.current) {
          toast.error(`Could not create ${trimmed}`, { description: message });
          return;
        }
        setStep(0);
        setCreateError(message);
      },
    );
  };

  // Sharing writes visibility and the chosen repos once the id is real. The
  // UI moves on right away; a failure surfaces as a toast.
  const finishSharing = (paths: Record<string, boolean>) => {
    setStep(indexOf("invite"));
    const p = teamIdPromise.current;
    if (!p) return;
    p.then((id) =>
      save({ teamId: id as Id<"teams">, visibility, selectedPaths: paths, allProjects: data.allProjects, shareSince: since }),
    ).catch((err) => {
      if (!teamIdPromise.current) return;
      console.error("Team setup save failed:", err);
      toast.error("Could not save the team settings", { description: "You can change them in Settings." });
    });
  };

  const leaveAgents = (all = false) => {
    agents.commit(all);
    if (solo) finish();
    else setStep(indexOf("sharing"));
  };

  // Rail jumps, both directions, to any visited step. A forward jump into
  // Invite still completes Sharing, the same way its Continue does.
  const selectStep = (i: number) => {
    if (i === step) return;
    if (i === 0) {
      returnTo.current = step;
      setStep(0);
      return;
    }
    if (step === 0) saveIdentityEdits();
    if (keys[i] === "invite" && step < i) {
      finishSharing(selectedPaths);
      return;
    }
    go(i);
  };

  const crest = { icon: identity.icon, color: identity.color, name: solo ? "Just me" : trimmed };
  const eyebrow = solo ? "Personal" : created ? "Team created" : "New team";
  const shell = {
    eyebrow,
    steps,
    stepIndex: step,
    visitedIndex: maxVisited,
    crest,
    onBack: goBack,
  };

  if (key === "team") {
    const canLeave = created || !welcome || solo;
    return (
      <TeamFlowShell
        {...shell}
        onStepSelect={created && nameValid ? selectStep : undefined}
        heading={welcome && !created ? "Start your team" : "Name your team"}
        description={welcome && !created ? "Chat, calls, tasks and your agents, shared with the people you build with." : "Pick a name, an icon and a color. You can change them later."}
        onBack={canLeave ? goBack : undefined}
        backLabel={created ? "Back" : "Cancel"}
        onSkip={welcome && !created ? () => { setSolo(true); setStep(1); } : undefined}
        skipLabel="Just me for now"
        formId={NAME_FORM_ID}
        continueLabel={created ? "Save and continue" : "Create team"}
        continueDisabled={!nameValid || !user}
      >
        <form id={NAME_FORM_ID} onSubmit={create} className="space-y-6">
          {welcome && !created && <DomainTeams />}
          <div>
            <div className="flex items-baseline justify-between">
              <Label htmlFor="teamName" className="text-sol-text">Team name</Label>
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

          <TeamIdentityPicker value={identity} onChange={setIdentity} />

          {!created && workDomain?.domain && workDomain.proven && (
            <label className="flex items-center justify-between gap-4 rounded-lg border border-sol-border bg-sol-bg-alt/40 px-4 py-3">
              <span className="text-sm text-sol-text">Let @{workDomain.domain} coworkers find this team</span>
              <Switch checked={findable} onCheckedChange={setFindable} aria-label={`Let @${workDomain.domain} coworkers find this team`} />
            </label>
          )}

          {createError && (
            <div role="alert" className="p-3 bg-sol-red/10 border border-sol-red/20 rounded-lg">
              <p className="text-sm text-sol-red">{createError}</p>
            </div>
          )}
        </form>
      </TeamFlowShell>
    );
  }

  if (key === "features") {
    return (
      <TeamFlowShell
        {...shell}
        onStepSelect={selectStep}
        heading="Everything your team gets"
        description="Each one works for people and agents alike."
        onSkip={features.allOn ? undefined : () => go(indexOf("agents"))}
        skipLabel={`Continue with ${features.onCount} ${features.onCount === 1 ? "feature" : "features"}`}
        onContinue={() => { features.turnAllOn(); go(indexOf("agents")); }}
        continueLabel={features.allOn ? "Continue" : `Turn on all ${features.total}`}
        enterAdvances
      >
        <FeatureStep teamId={teamId} />
      </TeamFlowShell>
    );
  }

  if (key === "agents") {
    return (
      <TeamFlowShell
        {...shell}
        onStepSelect={selectStep}
        heading="Connect your agents"
        description={solo ? "Sessions from this computer sync, and your agents learn to use Codecast." : "Sessions from this computer sync, and agents learn to use everything you just turned on."}
        onSkip={agents.allChosen ? undefined : () => leaveAgents()}
        skipLabel={`Continue with ${agents.chosen.size} agent ${agents.chosen.size === 1 ? "feature" : "features"}`}
        onContinue={() => leaveAgents(true)}
        continueLabel={agents.allChosen ? (solo ? "Finish" : "Continue") : `Turn on all ${agents.total}`}
        enterAdvances
      >
        <ConnectStep choice={agents} />
      </TeamFlowShell>
    );
  }

  if (key === "sharing") {
    return (
      <TeamFlowShell
        {...shell}
        onStepSelect={selectStep}
        heading="What teammates see"
        description="Pick the repos this team works in and how much of your work shows in its feed."
        onSkip={selectedCount > 0 ? () => finishSharing({}) : undefined}
        skipLabel="Skip for now"
        onContinue={() => finishSharing(selectedPaths)}
        continueLabel={shareActionLabel(impact, since) ?? "Continue"}
        enterAdvances
      >
        <div className="space-y-6">
          <VisibilityPicker value={visibility} onChange={setVisibility} compact />
          <WorkspaceSharePicker
            data={data}
            teamId={teamId}
            selectedPaths={selectedPaths}
            onToggle={toggle}
            isNewTeam
            impact={{
              teamName: trimmed || "Your team",
              memberCount: 1,
              visibility,
              since,
              onSinceChange: setSince,
            }}
          />
        </div>
      </TeamFlowShell>
    );
  }

  return (
    <TeamFlowShell
      {...shell}
      onStepSelect={selectStep}
      heading="Invite your team"
      description="Anyone who opens the link joins with every feature you turned on."
      onContinue={finish}
      continueLabel={welcome ? "Open Codecast" : "Open team"}
      enterAdvances
    >
      {teamId ? (
        <InvitePanel teamId={teamId} variant="page" />
      ) : (
        <div className="space-y-3" aria-busy="true">
          <div className="h-4 w-28 rounded bg-sol-bg-alt animate-pulse" />
          <div className="h-11 rounded-md bg-sol-bg-alt animate-pulse" />
        </div>
      )}
    </TeamFlowShell>
  );
}
