import { useEffect, useState } from "react";
import { GitBranch, Check, Terminal, Users } from "lucide-react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { formatRelative } from "../../lib/utils";
import {
  isMappedToTeam,
  type SuggestedWorkspace,
  type TeamWorkspaceSuggestions,
  type UserWorkspace,
} from "../../hooks/useTeamWorkspaceSuggestions";

/** Initial selection: workspaces teammates already share, plus those already
 *  mapped to this team. Pure so the create flow can reseed after the team id
 *  swaps from a stub to the real row. */
export function seedWorkspaceSelection(
  allProjects: UserWorkspace[],
  suggestedPaths: Set<string>,
  teamId: Id<"teams"> | null,
): Record<string, boolean> {
  const initial: Record<string, boolean> = {};
  for (const p of allProjects) {
    initial[p.path] = suggestedPaths.has(p.path) || isMappedToTeam(p, teamId);
  }
  return initial;
}

/** Owns the selected set for a share picker and reseeds it whenever the
 *  suggestion data or the target team changes. */
export function useWorkspaceSelection(
  data: Pick<TeamWorkspaceSuggestions, "allProjects" | "suggestedPaths">,
  teamId: Id<"teams"> | null,
) {
  const { allProjects, suggestedPaths } = data;
  const [selectedPaths, setSelectedPaths] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!allProjects) return;
    setSelectedPaths(seedWorkspaceSelection(allProjects, suggestedPaths, teamId));
  }, [allProjects, suggestedPaths, teamId]);

  const toggle = (path: string) =>
    setSelectedPaths((prev) => ({ ...prev, [path]: !prev[path] }));
  const selectedCount = Object.values(selectedPaths).filter(Boolean).length;
  return { selectedPaths, toggle, selectedCount };
}

function workspaceName(path: string) {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * The workspace share step: matched repos, the rest, the empty state that
 * points at the CLI, and repos teammates share that the viewer lacks locally.
 * `isNewTeam` swaps the copy for a team nobody has joined yet, where no
 * teammate matches can exist.
 */
export function WorkspaceSharePicker({
  data,
  teamId,
  selectedPaths,
  onToggle,
  isNewTeam = false,
  className = "",
}: {
  data: TeamWorkspaceSuggestions;
  teamId: Id<"teams"> | null;
  selectedPaths: Record<string, boolean>;
  onToggle: (path: string) => void;
  isNewTeam?: boolean;
  className?: string;
}) {
  const { allProjects, matched, other, teamName, teamOnlyRepos, getSuggestion } = data;
  const common = { selectedPaths, onToggle, getSuggestion, teamId };

  return (
    <div className={`space-y-5 ${className}`}>
      {matched.length > 0 && (
        <WorkspaceSection
          title="Shared by teammates"
          subtitle="Your teammates already share these repos. Pre-selected for you."
          workspaces={matched}
          {...common}
        />
      )}

      {other.length > 0 && (
        <WorkspaceSection
          title={isNewTeam ? "Your workspaces" : "Your other workspaces"}
          subtitle={
            isNewTeam
              ? "Pick the repos this team works in. Sessions there will show in the team feed."
              : "Select any additional workspaces you'd like to share."
          }
          workspaces={other}
          {...common}
        />
      )}

      {allProjects === undefined && (
        <div className="rounded-lg border border-sol-border bg-sol-bg-alt/40 px-4 py-8 text-center text-sm text-sol-base1">
          Loading your workspaces...
        </div>
      )}

      {allProjects && allProjects.length === 0 && (
        <div className="rounded-lg border border-sol-border bg-sol-bg-alt/40 px-4 py-5 space-y-3">
          <div className="text-sm text-sol-text font-medium">
            No workspaces found yet
          </div>
          <p className="text-xs text-sol-base1 leading-relaxed">
            Workspaces appear here once you start sessions with the
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
  );
}

function WorkspaceSection({
  title,
  subtitle,
  workspaces,
  selectedPaths,
  onToggle,
  getSuggestion,
  teamId,
}: {
  title: string;
  subtitle: string;
  workspaces: UserWorkspace[];
  selectedPaths: Record<string, boolean>;
  onToggle: (path: string) => void;
  getSuggestion: (path: string) => SuggestedWorkspace | undefined;
  teamId: Id<"teams"> | null;
}) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-sol-text">{title}</h3>
        <p className="text-xs text-sol-text-dim mt-0.5">{subtitle}</p>
      </div>
      <div className="space-y-1.5 max-h-[240px] overflow-y-auto pr-0.5">
        {workspaces.map((ws) => {
          const selected = !!selectedPaths[ws.path];
          const suggestion = getSuggestion(ws.path);
          const alreadyMapped = isMappedToTeam(ws, teamId);

          return (
            <button
              key={ws.path}
              type="button"
              onClick={() => onToggle(ws.path)}
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
                      {workspaceName(ws.path)}
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
                    {ws.path}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-sol-base01">
                    {suggestion && (
                      <span className="text-sol-cyan">
                        <Users className="w-3 h-3 inline mr-1" />
                        {suggestion.match_reason}
                      </span>
                    )}
                    <span>
                      {ws.session_count} session
                      {ws.session_count === 1 ? "" : "s"}
                    </span>
                    {ws.last_active > 0 && (
                      <span>{formatRelative(ws.last_active)}</span>
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
