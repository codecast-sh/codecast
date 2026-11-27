// `cast force-update` (index.ts wires it): which floor a call moves, decided
// here so it is tested without a backend. Platform staff raise the global
// floor; a team's admins and its Release Captain raise the team's, named with
// --team; a team's admins alone lower or clear it. Every raise is checked
// against latest.json: a floor above every published release is one no
// machine reaches, and each one below it would try again on every check.

import { isBelowMinimum } from "@platform/cli-kit/update";

export type ForceUpdateOptions = { team?: string; deploy?: string; clear?: boolean; lowerTo?: string };

export type ForceUpdateDeps = {
  /** The version latest.json names now, or null when it cannot be read. */
  latest: () => Promise<string | null>;
  /** Raise the global floor; false when the caller is not platform staff. */
  setGlobal: (version: string) => Promise<boolean>;
  /** The team a --team names, or null (the resolver has said why). */
  team: (name: string) => Promise<{ teamId: string; name: string } | null>;
  /** The caller's active team's name, to say which --team they meant; null when personal. */
  activeTeam: () => Promise<string | null>;
  post: (path: string, body: Record<string, unknown>) => Promise<any>;
  /** The release finish (releaseFinish.finishCliRelease) for --deploy. */
  finish: (version: string) => Promise<unknown>;
  fromSession?: string;
  log: (line: string) => void;
  error: (line: string) => void;
};

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Runs the command; the exit code. */
export async function runForceUpdate(version: string | undefined, o: ForceUpdateOptions, deps: ForceUpdateDeps): Promise<number> {
  const lowering = o.clear || o.lowerTo !== undefined;
  if (lowering && (o.clear && o.lowerTo !== undefined)) return fail(deps, "Pass --clear or --lower-to, not both.");
  if (lowering && version) return fail(deps, "--clear and --lower-to take no version argument.");
  if (lowering && !o.team) return fail(deps, "--clear and --lower-to move a team's floor: pass --team <team>.");
  const target = lowering ? o.lowerTo : version;
  if (!lowering && !target) return fail(deps, "Name the minimum version (e.g. 1.0.12).");
  if (target !== undefined && !SEMVER.test(target)) return fail(deps, "Invalid version format. Use semver (e.g., 1.0.12)");

  if (target) {
    const latest = await deps.latest().catch(() => null);
    if (latest && isBelowMinimum(latest, target)) {
      return fail(deps, `${target} is newer than the newest release (${latest}, latest.json): no machine could reach it, and every one below it would keep trying.`);
    }
    if (!latest) deps.error(`Could not read latest.json, so ${target} is not checked against the newest release.`);
  }

  if (lowering) {
    const ws = await deps.team(o.team!);
    if (!ws) return 1;
    const res = await deps.post("/cli/team-cli-floor/lower", { team_id: ws.teamId, ...(o.lowerTo ? { version: o.lowerTo } : {}) });
    if (!res.changed) deps.log(res.version ? `${res.team}'s minimum CLI version stands at ${res.version}; ${o.lowerTo} would not lower it` : `${res.team} has no minimum CLI version of its own`);
    else deps.log(res.version ? `${res.team}'s minimum CLI version lowered to ${res.version}` : `${res.team}'s minimum CLI version cleared`);
    return 0;
  }

  if (o.deploy) {
    await deps.finish(target!);
    return 0;
  }

  if (!o.team) {
    if (await deps.setGlobal(target!)) {
      deps.log(`Minimum CLI version set to ${target}`);
      deps.log("Remote daemons will auto-update within 5 minutes");
      return 0;
    }
    // Not platform staff: never move a team's floor on a guess at which team.
    const active = await deps.activeTeam().catch(() => null);
    return fail(deps, active
      ? `Only platform staff set every machine's minimum. To raise ${active}'s, run: cast force-update ${target} --team ${active}`
      : `Only platform staff set every machine's minimum. To raise a team's, pass --team <team>.`);
  }

  const ws = await deps.team(o.team);
  if (!ws) return 1;
  const set = await deps.post("/cli/team-cli-floor/set", { team_id: ws.teamId, version: target, ...(deps.fromSession ? { from_session: deps.fromSession } : {}) });
  deps.log(set.changed ? `${set.team}'s minimum CLI version set to ${set.version}` : `${set.team}'s minimum CLI version already stands at ${set.version}`);
  deps.log(`${set.team}'s daemons below it auto-update within 5 minutes`);
  return 0;
}

function fail(deps: ForceUpdateDeps, line: string): number {
  deps.error(line);
  return 1;
}
