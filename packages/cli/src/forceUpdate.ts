// `cast force-update`, a command group (commandGroups.ts) registered at the
// end: which floor a call moves, decided here so it is tested without a
// backend. Platform staff raise the global floor; a team's admins and its
// Release Captain raise the team's, named with --team; a team's admins alone
// lower or clear it. Every raise is checked against latest.json: a floor above
// every published release is one no machine reaches, and each one below it
// would try again on every check.

import type { Command } from "commander";
import { isBelowMinimum } from "@platform/cli-kit/update";
import type { GroupDeps } from "./commandGroupTypes.js";
import { commandGroup } from "./commandGroupLookup.js";
import { defaultConfigDir, readAuthConfig } from "./config/readAuthConfig.js";

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

export function registerForceUpdateCommand(program: Command, { flow }: GroupDeps): void {
  program
    .command("force-update")
    .description(commandGroup("force-update").description)
    .argument("[version]", "Minimum version required (e.g., 1.0.12)")
    .option("--team <team>", "Move this team's floor; without it only platform staff may run this, and it sets every machine's floor")
    .option("--deploy <deploy>", "A live CLI release's deploy (dp-N): raise its team's floor only when the daemon changed since the release the team was last forced onto, wait for the team's machines, and record both on the deploy")
    .option("--wait <minutes>", "With --deploy: how long to wait for the team's online machines to run it", "20")
    .option("--lower-to <version>", "With --team: lower the team's floor to this version (team admins)")
    .option("--clear", "With --team: clear the team's floor (team admins)")
    .action(async (version: string | undefined, options: { team?: string; deploy?: string; wait: string; lowerTo?: string; clear?: boolean }) => {
      const config = readAuthConfig(defaultConfigDir());
      if (!config?.auth_token || !config?.convex_url) {
        console.error("Not authenticated. Run: cast auth");
        process.exit(1);
      }
      const { convex_url: convexUrl, auth_token: authToken, user_id: userId } = config;
      const [{ SyncService }, { updater }] = await Promise.all([import("./syncService.js"), import("./update.js")]);
      const setGlobal = async (v: string) => {
        const sync = new SyncService({ convexUrl, authToken, userId });
        try { await sync.getClient().mutation("systemConfig:setMinCliVersion" as any, { version: v, api_token: authToken }); return true; }
        catch (err) { if (String(err instanceof Error ? err.message : err).includes("Admin access required")) return false; throw err; }
      };
      const post = (p: string, body: Record<string, unknown>) => flow.cliPost(p, body, { throwOnError: true });
      try {
        const code = await runForceUpdate(version, options, {
          latest: async () => (await updater.fetchManifest())?.version ?? null,
          setGlobal,
          team: async (name) => { const ws = await flow.writeWorkspace(name); return ws.kind === "team" ? { teamId: ws.teamId, name: ws.name ?? name } : null; },
          activeTeam: async () => { const ws = await flow.readWorkspace(); return ws.kind === "team" ? (ws.name ?? null) : null; },
          post,
          finish: async (v) => {
            const { finishCliRelease } = await import("./releaseFinish.js");
            return finishCliRelease({
              root: process.cwd(), deploy: options.deploy!, version: v, waitMs: (Number(options.wait) || 0) * 60_000,
              post, fromSession: flow.callingSession(), setGlobal,
              // No token: the global floor alone, not the caller's teams' raised over it.
              globalFloor: async () => (await new SyncService({ convexUrl, authToken, userId }).getClient().query("systemConfig:getMinCliVersion" as any, {})) as string | null,
            });
          },
          fromSession: flow.callingSession(),
          log: (l) => console.log(l),
          error: (l) => console.error(l),
        });
        process.exit(code);
      } catch (err) {
        console.error(`${options.deploy ? "Release finish" : "force-update"} failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
