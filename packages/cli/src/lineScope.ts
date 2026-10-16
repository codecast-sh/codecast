// The workspace and project a line write goes to: the repo profile's [line]
// defaults, and the scope a CLI call carries. A leaf, so command modules that
// only need a scope do not pull `cast signal` (and through it decide and
// publish) onto index.ts's static graph (bench/bootGraph.guard.test.ts).
import { apiPost, type PublishDeps } from "./castApi.js";
import { fmt } from "./colors.js";
import { loadWorkspaceRoster, resolveWorkspaceForRead, resolveWorkspaceForWrite, workspaceScope } from "./resolveWorkspace.js";
import { LineProfileError, loadLineProfile } from "./lineProfile.js";

function fail(message: string): never {
  console.error(fmt.error(message));
  process.exit(1);
}

const cwd = () => process.env.CODECAST_CWD || process.cwd();

/** This checkout's line profile defaults (LP2): the workspace and project its work goes to. */
export function lineDefaults(): { team?: string; project?: string } {
  try {
    const { profile } = loadLineProfile(cwd());
    return { team: profile.team ?? undefined, project: profile.project ?? undefined };
  } catch (err) {
    if (err instanceof LineProfileError) fail(err.message);
    throw err;
  }
}

/** The project a write files under: the one named, else the repo profile's
 *  `[line] project`, but only when the write lands in the profile's own
 *  workspace. A --team naming another workspace (personal, say) gets no
 *  project from the profile, since that project lives in the profile's team. */
export function lineProjectFor(team: string | undefined, project: string | undefined): string | undefined {
  if (project?.trim()) return project;
  const defaults = lineDefaults();
  const norm = (v: string | undefined) => v?.trim().toLowerCase() || undefined;
  if (norm(team) && norm(team) !== norm(defaults.team)) return undefined;
  return defaults.project;
}

/** The named workspace, else the repo profile's `[line] team`, else the
 *  server's own rule (the session's team, the directory). A write naming a
 *  team that is not one of yours stops here. `project` rides along for the
 *  server to resolve inside that workspace. */
export async function scopeFor(deps: PublishDeps, team: string | undefined, write: boolean, project?: string) {
  team ||= lineDefaults().team;
  const base = { project_path: cwd(), conversation_id: deps.detectCurrentSessionId() ?? undefined, ...(project?.trim() ? { project: project.trim() } : {}) };
  if (!team) return base;
  const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true }));
  try {
    return { ...base, ...workspaceScope(write ? resolveWorkspaceForWrite(roster, team) : resolveWorkspaceForRead(roster, team)) };
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
