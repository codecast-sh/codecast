// `cast cap publish <name>` and `cast cap unpublish <name>`: put a local
// skill, command, subagent or one CLAUDE.md section into a workspace's kit,
// or take an item out of it. The publish work is kitPublish.ts's (the
// daemon's cap_publish runs the same code); this file resolves the workspace
// and prints.

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "../castApi.js";
import { loadWorkspaceRoster, resolveWorkspaceForWrite, WorkspaceUnresolved } from "../resolveWorkspace.js";
import { lineDefaults } from "../lineScope.js";
import { deviceId } from "../remote/device.js";
import type { KitWorkspace } from "./kitPublish.js";

interface PublishOpts {
  kind?: string;
  note?: string;
  team?: string;
  instructions?: string;
  json?: boolean;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The kit a write goes to: --team, else the repo's [line] team, else the
 *  active team, else the person's own (resolveWorkspaceForWrite). */
async function kitWorkspace(deps: PublishDeps, team: string | undefined): Promise<{ workspace: KitWorkspace; label: string }> {
  const roster = await loadWorkspaceRoster(async () => await apiPost(deps, "/cli/teams", {}, { read: true }));
  try {
    const ws = resolveWorkspaceForWrite(roster, team || lineDefaults().team);
    if (ws.kind === "team") {
      return { workspace: { kind: "team", teamId: ws.teamId }, label: roster.teams.find((t) => t._id === ws.teamId)?.name ?? ws.teamId };
    }
    const userId = roster.userId ?? (await apiPost(deps, "/cli/whoami", {}, { read: true }).then((me: any) => me?.user_id ?? me?._id));
    if (!userId) fail("Could not tell who you are; run `cast auth status`.");
    return { workspace: { kind: "personal", userId }, label: "your personal kit" };
  } catch (err) {
    if (err instanceof WorkspaceUnresolved) fail(err.message);
    throw err;
  }
}

export function registerCapPublish(cap: Command, deps: PublishDeps): void {
  cap
    .command("publish [name]")
    .description("Share a skill, command, subagent or instruction section with your team's kit (or your own)")
    .option("--kind <kind>", "skill, command or subagent, when the name matches more than one")
    .option("--instructions <file#heading>", "Publish one markdown section, e.g. CLAUDE.md#Release checklist")
    .option("--note <text>", "What changed in this version")
    .option("--team <name|id>", "The workspace to publish into (\"personal\" for your own kit)")
    .option("--json", "Machine-readable output")
    .action(async (name: string | undefined, opts: PublishOpts) => {
      const kit = await import("./kitPublish.js");
      if (!name && !opts.instructions) fail("Name the item to publish, or pass --instructions <file>#<heading>.");
      if (opts.kind && (!kit.isKitKind(opts.kind) || opts.kind === "instructions")) fail(`--kind is skill, command or subagent, not "${opts.kind}"`);
      const { workspace, label } = await kitWorkspace(deps, opts.team);

      try {
        const result = await kit.publishKitItem(
          { name, kind: opts.kind as any, instructions: opts.instructions, projectPath: process.env.CODECAST_CWD || process.cwd() },
          {
            home: process.env.HOME || require("os").homedir(),
            workspace,
            deviceId: deviceId(),
            note: opts.note,
            post: (route, body) => apiPost(deps, route, body, { exitOnError: false }),
          },
        );
        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const files = `${result.file_count} file${result.file_count === 1 ? "" : "s"}`;
        if (result.status === "unchanged") {
          console.log(`unchanged  ${result.kind} ${result.name}${result.version ? ` v${result.version}` : ""} is already the current version in ${label}`);
        } else {
          console.log(`published  ${result.kind} ${result.name}${result.version ? ` v${result.version}` : ""} to ${label} (${files})`);
        }
        console.log(`  ${result.slug}`);
        if (result.surfaces?.some((x) => x !== "prose" && x !== "reads_files")) {
          console.log(`  runs code (${result.surfaces.join(", ")}): each machine installs it only after its owner allows it`);
        }
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}

export function registerCapUnpublish(cap: Command, deps: PublishDeps): void {
  cap
    .command("unpublish <name>")
    .description("Take an item out of your team's kit (or your own); every machine that installed it removes it")
    .option("--kind <kind>", "skill, command, subagent or instructions, when the name matches more than one")
    .option("--team <name|id>", "The workspace whose kit holds it (\"personal\" for your own)")
    .option("-y, --yes", "Skip the confirmation")
    .option("--json", "Machine-readable output")
    .action(async (name: string, opts: { kind?: string; team?: string; yes?: boolean; json?: boolean }) => {
      const kit = await import("./kitPublish.js");
      if (opts.kind && !kit.isKitKind(opts.kind)) fail(`--kind is skill, command, subagent or instructions, not "${opts.kind}"`);
      const { workspace, label } = await kitWorkspace(deps, opts.team);

      const listed = await apiPost(deps, "/cli/cap/kit/list", workspace.kind === "team" ? { team_id: workspace.teamId } : { personal: true }, { read: true });
      const hits: Array<{ slug: string; kind: string; name: string; current_version?: number }> = (listed?.items ?? []).filter(
        (i: any) => i.name === name && (!opts.kind || i.kind === opts.kind),
      );
      if (hits.length === 0) fail(`Nothing named "${name}" in ${label}.`);
      if (hits.length > 1) fail(`"${name}" names ${hits.length} items in ${label}; pass --kind:\n${hits.map((h) => `  ${h.kind}  ${h.slug}`).join("\n")}`);
      const item = hits[0]!;

      if (!opts.yes) {
        if (!process.stdin.isTTY) fail(`Unpublishing removes ${item.kind} ${item.name} from every machine that installed it. Re-run with --yes to confirm.`);
        const { askYesNo } = await import("../terminalAsk.js");
        if (!(await askYesNo(`Remove ${item.kind} ${item.name} from ${label} and from every machine that installed it? [y/N] `))) process.exit(1);
      }

      const res = await apiPost(deps, "/cli/cap/kit/remove", { slug: item.slug });
      if (opts.json) {
        console.log(JSON.stringify({ slug: item.slug, ...res }, null, 2));
        return;
      }
      if (res?.status === "not_found") fail(`${item.slug} is not in ${label} any more, or you cannot read it.`);
      if (res?.status === "already_removed") console.log(`already removed  ${item.kind} ${item.name} from ${label}`);
      else console.log(`unpublished  ${item.kind} ${item.name} from ${label}${res?.disabled ? ` (switched off ${res.disabled} binding${res.disabled === 1 ? "" : "s"})` : ""}`);
      console.log(`  ${item.slug}`);
    });
}
