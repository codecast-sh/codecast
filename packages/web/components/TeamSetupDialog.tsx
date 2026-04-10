import { useEffect, useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import {
  EyeOff, BarChart2, FileText, BookOpen,
  GitBranch, Check, Terminal, Users, ArrowRight, ArrowLeft,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { TeamIcon } from "./TeamIcon";

type TeamVisibility = "hidden" | "activity" | "summary" | "full";

const VISIBILITY_LEVELS = [
  {
    value: "full" as const,
    label: "Full Access",
    Icon: BookOpen,
    accent: "sol-green",
    description: "Teammates can read complete session transcripts",
    detail:
      "Maximum transparency. Great for code review, knowledge sharing, and collaborative debugging.",
    preview: "Full conversation history visible",
    recommended: true,
  },
  {
    value: "summary" as const,
    label: "Summary",
    Icon: FileText,
    accent: "sol-cyan",
    description: "Teammates see titles and AI-generated summaries",
    detail:
      "Share what you worked on and the outcomes without revealing full conversations. Balances transparency with privacy.",
    preview: '"Fix auth bug — Updated login flow, added error handling"',
  },
  {
    value: "activity" as const,
    label: "Activity Only",
    Icon: BarChart2,
    accent: "sol-yellow",
    description: "Teammates see project names and session counts",
    detail:
      'Like a status light — teammates know you\'re active in a project, but can\'t see any session content.',
    preview: '"3 sessions in codecast today"',
  },
  {
    value: "hidden" as const,
    label: "Hidden",
    Icon: EyeOff,
    accent: "sol-base01",
    description: "Your work is invisible to the team",
    detail:
      "You can see teammates' shared sessions, but they won't see any of yours. Good for confidential or personal projects.",
    preview: "Teammates see: nothing",
  },
];

type SuggestedProject = {
  path: string;
  git_remote_url: string | null;
  session_count: number;
  last_active: number;
  matched_member_count: number;
  match_type: "github" | "repo_name";
  match_reason: string;
  current_team_id: Id<"teams"> | null;
};

type TeamOnlyRepo = {
  repo_key: string;
  repo_name: string;
  member_count: number;
};

type SuggestionsResult = {
  team_id: Id<"teams">;
  team_name: string;
  team_icon?: string | null;
  team_icon_color?: string | null;
  current_visibility: TeamVisibility;
  suggestions: SuggestedProject[];
  team_only_repos: TeamOnlyRepo[];
};

type UserProject = {
  path: string;
  is_git_repo: boolean;
  git_remote_url?: string;
  session_count: number;
  last_active: number;
  team_id: Id<"teams"> | null;
  auto_share: boolean;
};

export function TeamSetupDialog() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setupTeamId = (searchParams.get("teamId") as Id<"teams"> | null) || null;
  const teamSetupRequested = searchParams.get("teamSetup") === "1";

  const suggestions = useQuery(
    api.users.getSuggestedTeamProjects,
    setupTeamId ? { team_id: setupTeamId } : "skip",
  ) as SuggestionsResult | null | undefined;

  const allProjects = useQuery(
    api.users.getRecentProjectsWithGitInfo,
    setupTeamId ? { limit: 30 } : "skip",
  ) as UserProject[] | undefined;

  const setTeamVisibilityMut = useMutation(api.teams.setTeamVisibility);
  const updateDirectoryMapping = useMutation(api.users.updateDirectoryTeamMapping);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"visibility" | "projects">("visibility");
  const [visibility, setVisibility] = useState<TeamVisibility>("full");
  const [selectedPaths, setSelectedPaths] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  // Open dialog when URL params are present
  useEffect(() => {
    if (teamSetupRequested && setupTeamId) {
      setOpen(true);
    }
  }, [teamSetupRequested, setupTeamId]);

  // Seed defaults from backend
  useEffect(() => {
    if (!suggestions) return;
    setVisibility(suggestions.current_visibility || "summary");
  }, [suggestions?.team_id, suggestions?.current_visibility]);

  // Build selection map: pre-select suggested (teammate-matched) projects
  const suggestedPaths = useMemo(
    () => new Set(suggestions?.suggestions.map((s) => s.path) ?? []),
    [suggestions?.suggestions],
  );

  useEffect(() => {
    if (!allProjects) return;
    const initial: Record<string, boolean> = {};
    for (const p of allProjects) {
      // Pre-select projects that teammates already share, or that are already mapped to this team
      initial[p.path] =
        suggestedPaths.has(p.path) ||
        (p.team_id?.toString() === setupTeamId?.toString() && p.auto_share);
    }
    setSelectedPaths(initial);
  }, [allProjects, suggestedPaths, setupTeamId]);

  const close = () => {
    setOpen(false);
    setStep("visibility");
    if (!teamSetupRequested) return;
    const next = new URLSearchParams(searchParams.toString());
    next.delete("teamSetup");
    next.delete("teamId");
    const q = next.toString();
    router.replace(q ? `/settings/sync?${q}` : "/settings/sync");
  };

  const handleSave = async () => {
    if (!setupTeamId) {
      close();
      return;
    }
    setSaving(true);
    try {
      await setTeamVisibilityMut({ team_id: setupTeamId, visibility });

      const paths = Object.entries(selectedPaths)
        .filter(([, v]) => v)
        .map(([p]) => p);

      let mapped = 0;
      for (const path of paths) {
        const project = allProjects?.find((p) => p.path === path);
        if (project?.team_id?.toString() === setupTeamId.toString() && project?.auto_share) {
          continue; // already mapped
        }
        await updateDirectoryMapping({
          path_prefix: path,
          team_id: setupTeamId,
          auto_share: true,
        });
        mapped++;
      }

      const teamName = suggestions?.team_name || "team";
      if (mapped > 0) {
        toast.success(`Sharing ${mapped} project${mapped === 1 ? "" : "s"} with ${teamName}`);
      } else {
        toast.success(`Saved ${teamName} settings`);
      }
      close();
    } catch (err) {
      console.error("Team setup save failed:", err);
      toast.error("Failed to save team setup");
    } finally {
      setSaving(false);
    }
  };

  const toggleProject = (path: string) => {
    setSelectedPaths((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  const selectedCount = Object.values(selectedPaths).filter(Boolean).length;

  const teamName = suggestions?.team_name || "your team";
  const teamOnlyRepos = suggestions?.team_only_repos ?? [];

  // Separate projects into matched (teammates share) and other
  const matchedProjects: UserProject[] = [];
  const otherProjects: UserProject[] = [];
  for (const p of allProjects ?? []) {
    if (suggestedPaths.has(p.path)) {
      matchedProjects.push(p);
    } else {
      otherProjects.push(p);
    }
  }

  const getProjectName = (path: string) => {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  };

  const getRelativeTime = (ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  const getSuggestion = (path: string) =>
    suggestions?.suggestions.find((s) => s.path === path);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="bg-sol-bg border-sol-border max-w-2xl max-h-[85vh] overflow-hidden flex flex-col p-0">
        {/* Step indicator */}
        <div className="flex items-center gap-3 px-6 pt-6 pb-2">
          <StepIndicator
            number={1}
            label="Visibility"
            active={step === "visibility"}
            completed={step === "projects"}
          />
          <div className="h-px flex-1 bg-sol-border" />
          <StepIndicator
            number={2}
            label="Projects"
            active={step === "projects"}
            completed={false}
          />
        </div>

        {step === "visibility" ? (
          <>
            <DialogHeader className="px-6 pt-2">
              <div className="flex items-center gap-3 mb-1">
                {suggestions?.team_icon && (
                  <div className="w-9 h-9 rounded-lg bg-sol-bg-alt border border-sol-border flex items-center justify-center">
                    <TeamIcon
                      icon={suggestions.team_icon}
                      color={suggestions.team_icon_color}
                      className="w-5 h-5"
                    />
                  </div>
                )}
                <DialogTitle className="text-sol-text text-xl">
                  Welcome to {teamName}
                </DialogTitle>
              </div>
              <DialogDescription className="text-sol-base1 text-sm">
                Choose how your work appears to teammates. This controls what
                they see in the team feed. You can change it anytime.
              </DialogDescription>
            </DialogHeader>

            <div className="flex-1 overflow-y-auto px-6 py-3 space-y-2.5">
              {VISIBILITY_LEVELS.map((level) => {
                const selected = visibility === level.value;
                const Icon = level.Icon;
                return (
                  <button
                    key={level.value}
                    onClick={() => setVisibility(level.value)}
                    className={`w-full rounded-xl border px-5 py-4 text-left transition-all relative ${
                      selected
                        ? "border-sol-cyan bg-sol-cyan/[0.06] ring-1 ring-sol-cyan/30"
                        : "border-sol-border hover:border-sol-base01 hover:bg-sol-bg-alt/40"
                    }`}
                  >
                    {level.recommended && (
                      <span className="absolute top-3 right-4 text-[10px] uppercase tracking-wider font-semibold text-sol-cyan">
                        Recommended
                      </span>
                    )}
                    <div className="flex items-start gap-4">
                      <div
                        className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                          selected
                            ? "bg-sol-cyan/15 text-sol-cyan"
                            : "bg-sol-bg-alt text-sol-base01"
                        }`}
                      >
                        <Icon className="w-5 h-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-sol-text">
                          {level.label}
                        </div>
                        <div className="mt-0.5 text-sm text-sol-base1">
                          {level.description}
                        </div>
                        <div className="mt-2 text-xs text-sol-text-dim leading-relaxed">
                          {level.detail}
                        </div>
                        <div className="mt-2 rounded-md bg-sol-bg-alt/60 border border-sol-border/50 px-3 py-1.5 text-xs text-sol-base1 font-mono">
                          {level.preview}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <DialogFooter className="px-6 pb-6 pt-3 border-t border-sol-border gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={close}
                className="border-sol-border text-sol-base1"
              >
                Skip for now
              </Button>
              <Button
                onClick={() => setStep("projects")}
                className="bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90 gap-1.5"
              >
                Continue
                <ArrowRight className="w-4 h-4" />
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader className="px-6 pt-2">
              <DialogTitle className="text-sol-text text-lg">
                Share projects with {teamName}
              </DialogTitle>
              <DialogDescription className="text-sol-base1 text-sm">
                Select projects to automatically share with the team. New
                sessions in shared projects will appear in the team feed.
              </DialogDescription>
            </DialogHeader>

            <div className="flex-1 overflow-y-auto px-6 py-2 space-y-5 min-h-0">
              {/* Matched projects — teammates already share these */}
              {matchedProjects.length > 0 && (
                <ProjectSection
                  title="Shared by teammates"
                  subtitle="Your teammates already share these repos. Pre-selected for you."
                  projects={matchedProjects}
                  selectedPaths={selectedPaths}
                  onToggle={toggleProject}
                  getProjectName={getProjectName}
                  getRelativeTime={getRelativeTime}
                  getSuggestion={getSuggestion}
                  setupTeamId={setupTeamId}
                />
              )}

              {/* Other projects */}
              {otherProjects.length > 0 && (
                <ProjectSection
                  title="Your other projects"
                  subtitle="Select any additional projects you'd like to share."
                  projects={otherProjects}
                  selectedPaths={selectedPaths}
                  onToggle={toggleProject}
                  getProjectName={getProjectName}
                  getRelativeTime={getRelativeTime}
                  getSuggestion={getSuggestion}
                  setupTeamId={setupTeamId}
                />
              )}

              {/* Loading state */}
              {allProjects === undefined && (
                <div className="rounded-lg border border-sol-border bg-sol-bg-alt/40 px-4 py-8 text-center text-sm text-sol-base1">
                  Loading your projects...
                </div>
              )}

              {/* No local projects — show CLI install guidance */}
              {allProjects && allProjects.length === 0 && (
                <div className="rounded-lg border border-sol-border bg-sol-bg-alt/40 px-4 py-5 space-y-3">
                  <div className="text-sm text-sol-text font-medium">
                    No projects found yet
                  </div>
                  <p className="text-xs text-sol-base1 leading-relaxed">
                    Projects appear here once you start sessions with the
                    Codecast CLI. Install and authenticate, then your repos will
                    be available to share.
                  </p>
                  <div className="font-mono text-xs text-sol-base1 bg-sol-bg rounded-md border border-sol-border/50 px-3 py-2 select-all">
                    curl -fsSL codecast.sh/install | sh
                  </div>
                  <p className="text-[11px] text-sol-text-dim">
                    After installing, run{" "}
                    <span className="font-mono text-sol-base1">cast auth</span>{" "}
                    to connect your account, then start a session in any git
                    repo.
                  </p>
                </div>
              )}

              {/* Team repos the user doesn't have locally */}
              {teamOnlyRepos.length > 0 && (
                <div className="space-y-2">
                  <div>
                    <h3 className="text-sm font-medium text-sol-text">
                      Team repos you don't have yet
                    </h3>
                    <p className="text-xs text-sol-text-dim mt-0.5">
                      These repos are shared by teammates but weren't found in
                      your recent sessions. Clone them and map via the CLI.
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    {teamOnlyRepos.map((repo) => (
                      <div
                        key={repo.repo_key}
                        className="rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 px-4 py-3"
                      >
                        <div className="flex items-center gap-2">
                          <GitBranch className="w-4 h-4 text-sol-base01 shrink-0" />
                          <span className="text-sm font-medium text-sol-text">
                            {repo.repo_key}
                          </span>
                          <span className="text-xs text-sol-base01">
                            {repo.member_count} teammate{repo.member_count === 1 ? "" : "s"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-lg border border-sol-border/60 bg-sol-bg-alt/50 px-4 py-3 space-y-2">
                    <div className="flex items-center gap-2 text-xs font-medium text-sol-text">
                      <Terminal className="w-3.5 h-3.5 text-sol-cyan" />
                      Share a repo via CLI
                    </div>
                    <div className="font-mono text-xs text-sol-base1 bg-sol-bg rounded-md border border-sol-border/50 px-3 py-2 select-all">
                      cast teams map /path/to/repo {teamName}
                    </div>
                    <p className="text-[11px] text-sol-text-dim leading-relaxed">
                      Clone the repo, then run the command above from anywhere.
                      Or use{" "}
                      <span className="font-mono text-sol-base1">
                        cast sync-settings
                      </span>{" "}
                      for interactive setup.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="px-6 pb-6 pt-3 border-t border-sol-border gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={() => setStep("visibility")}
                className="border-sol-border text-sol-base1 gap-1.5"
              >
                <ArrowLeft className="w-4 h-4" />
                Back
              </Button>
              <div className="flex items-center gap-3 sm:ml-auto">
                <span className="text-xs text-sol-base01">
                  {selectedCount} project{selectedCount === 1 ? "" : "s"} selected
                </span>
                <Button
                  onClick={handleSave}
                  disabled={saving || !setupTeamId}
                  className="bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90"
                >
                  {saving ? "Saving..." : "Save & Start"}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Step indicator dot ──────────────────────────────────────────────

function StepIndicator({
  number,
  label,
  active,
  completed,
}: {
  number: number;
  label: string;
  active: boolean;
  completed: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
          active
            ? "bg-sol-cyan text-sol-bg"
            : completed
              ? "bg-sol-cyan/20 text-sol-cyan"
              : "bg-sol-bg-alt text-sol-base01 border border-sol-border"
        }`}
      >
        {completed ? <Check className="w-3.5 h-3.5" /> : number}
      </div>
      <span
        className={`text-xs font-medium ${
          active ? "text-sol-text" : "text-sol-base01"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

// ── Project list section ────────────────────────────────────────────

function ProjectSection({
  title,
  subtitle,
  projects,
  selectedPaths,
  onToggle,
  getProjectName,
  getRelativeTime,
  getSuggestion,
  setupTeamId,
}: {
  title: string;
  subtitle: string;
  projects: UserProject[];
  selectedPaths: Record<string, boolean>;
  onToggle: (path: string) => void;
  getProjectName: (path: string) => string;
  getRelativeTime: (ts: number) => string;
  getSuggestion: (path: string) => SuggestedProject | undefined;
  setupTeamId: Id<"teams"> | null;
}) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-sol-text">{title}</h3>
        <p className="text-xs text-sol-text-dim mt-0.5">{subtitle}</p>
      </div>
      <div className="space-y-1.5 max-h-[240px] overflow-y-auto pr-0.5">
        {projects.map((project) => {
          const selected = !!selectedPaths[project.path];
          const suggestion = getSuggestion(project.path);
          const alreadyMapped =
            project.team_id?.toString() === setupTeamId?.toString() &&
            project.auto_share;

          return (
            <button
              key={project.path}
              onClick={() => onToggle(project.path)}
              className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                selected
                  ? "border-sol-cyan bg-sol-cyan/[0.06]"
                  : "border-sol-border hover:border-sol-base01 hover:bg-sol-bg-alt/40"
              }`}
            >
              <div className="flex items-start gap-3">
                <div
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                    selected
                      ? "border-sol-cyan bg-sol-cyan text-sol-bg"
                      : "border-sol-border bg-sol-bg-alt"
                  }`}
                >
                  {selected && <Check className="w-3 h-3" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-sol-cyan shrink-0" />
                    <span className="truncate text-sm font-medium text-sol-text">
                      {getProjectName(project.path)}
                    </span>
                    {suggestion?.match_type === "github" && (
                      <span className="rounded border border-sol-cyan/30 bg-sol-cyan/10 px-1.5 py-0.5 text-[10px] text-sol-cyan whitespace-nowrap">
                        GitHub match
                      </span>
                    )}
                    {alreadyMapped && (
                      <span className="rounded border border-sol-green/30 bg-sol-green/10 px-1.5 py-0.5 text-[10px] text-sol-green whitespace-nowrap">
                        Already shared
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-sol-text-dim">
                    {project.path}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-sol-base01">
                    {suggestion && (
                      <span className="text-sol-cyan">
                        <Users className="w-3 h-3 inline mr-1" />
                        {suggestion.match_reason}
                      </span>
                    )}
                    <span>
                      {project.session_count} session
                      {project.session_count === 1 ? "" : "s"}
                    </span>
                    {project.last_active > 0 && (
                      <span>{getRelativeTime(project.last_active)}</span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
