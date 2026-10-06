// Role operations added with org-staffing.md S32 to S34 and the-line.md L12:
// `cast role split`, `cast role handoff`, and the `cast line merge` step the
// shipped line runs. Registered from index.ts onto the existing role group.

import type { Command } from "commander";
import type { OrgInitDeps } from "./orgInit.js";
import { readStdinBody } from "./sendBody.js";
import { registerLineProfileCommands } from "./lineProfileCommand.js";
import type { PublishDeps } from "./castApi.js";

export interface RoleOpsDeps extends OrgInitDeps {
  /** @handle, or-N or a raw id to a role id, exiting with a message when it is a person. */
  resolveRoleId: (ref: string, team?: string) => Promise<string>;
  /** The signal door's deps: `cast line profile --publish` scopes its write the way `cast signal add` does. */
  publishDeps: PublishDeps;
}

/** `--into 'handle|Name|ref,ref'`: the handle, the display name and the
 *  projects or plans (project:<ref>, plan:<ref>, or a bare project ref). */
export function parseSplitHalf(raw: string): { handle: string; name: string; refs: string[] } {
  const parts = raw.split("|").map((p) => p.trim());
  if (parts.length !== 3) throw new Error(`--into expects 'handle|Name|ref,ref', not "${raw}"`);
  const [handle, name, refs] = parts;
  if (!/^[a-z0-9-]{2,32}$/.test(handle.replace(/^@/, ""))) throw new Error(`"${handle}" is not a handle (a-z, 0-9 and -, 2 to 32 characters)`);
  if (!name) throw new Error(`--into ${handle}: the role needs a name`);
  const list = refs.split(",").map((r) => r.trim()).filter(Boolean);
  if (!list.length) throw new Error(`--into ${handle}: name at least one project or plan`);
  return { handle: handle.replace(/^@/, ""), name, refs: list };
}

export function registerOrgRoleOpsCommands(program: Command, deps: RoleOpsDeps): void {
  const role = program.commands.find((c) => c.name() === "role");
  if (!role) throw new Error("Register the role group before its operations");
  const c = { green: "\x1b[32m", dim: "\x1b[2m", yellow: "\x1b[33m", reset: "\x1b[0m" };

  // Split a role into two leads (S34): one gesture, a person's.
  role
    .command("split")
    .description("Split a role into two leads with disjoint areas, both reporting where it did; its knowledge is handed to each (a person's act)")
    .argument("<handle>", "The role to split: @handle or or-N")
    .requiredOption("--into <spec>", "One new role: 'handle|Name|ref,ref' with project:<ref> or plan:<ref> items (bare refs are projects); pass it twice", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--retire-session", "Retire the original's standing session when the handoff lands (default: keep it running as a plain agent)")
    .option("--team <name|id>", "Team workspace")
    .option("--json", "Machine-readable output")
    .action(async (handle: string, options: any) => {
      let halves: Array<{ handle: string; name: string; refs: string[] }>;
      try {
        if (options.into.length !== 2) throw new Error("A split makes exactly two roles: pass --into twice");
        halves = options.into.map(parseSplitHalf);
      } catch (err) { console.error((err as Error).message); process.exit(1); }
      const role_id = await deps.resolveRoleId(handle, options.team);
      const result = await deps.cliPost("/cli/role/split", { role_id, halves, standing_session: options.retireSession ? "retire" : "keep", from_session: deps.callingSession() });
      if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`${c.green}✓${c.reset} @${result.original.handle} ${c.dim}(${result.original.short_id})${c.reset} split into:`);
      for (const r of result.roles) {
        const scope = [...(r.scope?.project_ids ?? []).map((id: string) => `project ${id}`), ...(r.scope?.plan_ids ?? []).map((id: string) => `plan ${id}`)];
        console.log(`  @${r.handle} ${c.dim}(${r.short_id})${c.reset} ${r.name}: ${scope.join(", ")}${r.provisioned ? "" : ` ${c.yellow}(no standing session${r.provision_error ? `: ${r.provision_error}` : ""})${c.reset}`}`);
      }
      if (result.handoff) {
        console.log(`  handing over to ${result.handoff.receivers.map((r: any) => `@${r.handle} (${r.lines} line${r.lines === 1 ? "" : "s"})`).join(", ")}; @${result.original.handle} retires when it lands or by ${new Date(result.handoff.deadline).toLocaleString()}`);
      } else if (result.retired) {
        console.log(`  @${result.original.handle} retired now (nothing to hand over)`);
      }
    });

  // The outgoing role hands over what its lines do not say (S32).
  role
    .command("handoff")
    .description("Hand a receiving role what your lines do not say: the text lands in its brief and wakes it (run inside the outgoing role's session)")
    .argument("<receiver>", "The receiving role: @handle or or-N")
    .argument("[body]", "The handoff text; '-' or no argument reads stdin")
    .option("--from <handle>", "The outgoing role, when run by an admin outside its session")
    .option("--team <name|id>", "Team workspace")
    .option("--json", "Machine-readable output")
    .action(async (receiver: string, body: string | undefined, options: any) => {
      const text = body && body !== "-" ? body : readStdinBody();
      if (!text?.trim()) { console.error("Pass the handoff text as an argument or on stdin."); process.exit(1); }
      const to = await deps.resolveRoleId(receiver, options.team);
      const from_role = options.from ? await deps.resolveRoleId(options.from, options.team) : undefined;
      const result = await deps.cliPost("/cli/role/handoff", { receiver: to, body: text, from_session: deps.callingSession(), ...(from_role ? { from_role } : {}) });
      if (options.json) { console.log(JSON.stringify(result, null, 2)); return; }
      console.log(`${c.green}✓${c.reset} handed ${result.areas.length ? result.areas.join(", ") : "your area"} from @${result.from} to @${result.to} (${result.chars} characters, in its brief; it was woken)`);
      if (result.handoff === "complete") console.log(`  the handoff is complete${result.retired ? "; @" + result.from + " is retired" : ""}`);
      else if (result.handoff === "partial") console.log(`  other receivers still wait on you`);
    });

  // The merge step (L12), run by the shipped line's merge node.
  const line = program.command("line").description("The line a role's tasks run on (docs/architecture/the-line.md)");
  line
    .command("fixloop")
    .description("Trace each fix commit to the commit, session, line run and role that introduced the lines it changed (SZZ: parent-revision blame)")
    .option("--since <window>", "How far back to look for fix commits (git --since)", "7d")
    .option("--cwd <path>", "The repository checkout (default: the current directory)")
    .option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const { traceFixes, formatFixloop, rollupByRole } = await import("./lineFixloop.js");
      const { readAuthConfig } = await import("./config/readAuthConfig.js");
      const { defaultConfigDir } = await import("./config/configDir.js");
      const since = /^\d+d$/.test(options.since) ? `${options.since.slice(0, -1)} days ago` : options.since;
      const traces = await traceFixes({ cwd: options.cwd || process.cwd(), since, config: (readAuthConfig(defaultConfigDir()) ?? {}) as any });
      if (options.json) console.log(JSON.stringify({ since: options.since, traces, by_role: rollupByRole(traces) }, null, 2));
      else console.log(formatFixloop(traces));
    });
  line
    .command("merge")
    .description("Merge an approved run's branch into the default branch when the role's line allows it (the shipped line's merge node)")
    .requiredOption("--run <id>", "The workflow run")
    .requiredOption("--branch <name>", "The branch the implementer pushed")
    .option("--into <branch>", "The default branch (default: origin HEAD, else main)")
    .option("--cwd <path>", "The repository checkout (default: the current directory)")
    .option("--task <ct-N>", "The run's task: a merge left to a person is said there as a blocker")
    .option("--json", "Machine-readable output")
    .action(async (options: any) => {
      const { runMergeStep, defaultExec } = await import("./lineMerge.js");
      const cwd = options.cwd || process.cwd();
      const head = defaultExec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
      const into = options.into || (head.status === 0 ? head.stdout.trim().replace(/^origin\//, "") : "main");
      // Throwing, never exiting: a server that refuses or cannot be read is a
      // merge left to a person (exit 0), not a failed station.
      const post = (path: string, body: Record<string, unknown>) => deps.cliPost(path, body, { throwOnError: true });
      const result = await runMergeStep({ cwd, run_id: options.run, branch: options.branch, into, task: options.task || undefined, post, log: (l) => { if (!options.json) console.log(l); } });
      if (options.json) console.log(JSON.stringify(result, null, 2));
    });

  // The repo's line profile and the eval station's builder (line-profile.md LP2, LP4).
  registerLineProfileCommands(line, deps.publishDeps);
}
