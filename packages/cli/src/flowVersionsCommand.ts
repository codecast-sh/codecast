// `cast flow save|versions|restore|pin` (ct-70169): where a flow's runs read
// its graph, and its versions. A flow in the library runs its current version
// on every machine; `save` switches a flow there from its file and saves
// later edits, `restore` writes an older version back as the current one,
// `pin --repo` makes its runs read the checkout's file again. The server's
// side is convex/flowVersions.ts.
import type { Command } from "commander";
import * as path from "node:path";
import { notFoundLine } from "./argChecks.js";
import type { Workspace } from "./resolveWorkspace.js";

type Post = (urlPath: string, body: Record<string, any>, opts?: { timeoutMs?: number; throwOnError?: boolean }) => Promise<any>;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

type Version = { n: number; id: string; at: number; by: string | null; changed: string[]; restorable: boolean; current: boolean };

/** One version as a line: number, when, who, what moved, which runs read it now. */
export function versionLine(v: Version): string {
  const when = new Date(v.at).toISOString().slice(0, 16).replace("T", " ");
  const moved = v.changed.length ? v.changed.join(", ") : "no stations moved";
  return `${v.current ? "*" : " "} v${v.n}  ${when}  ${(v.by ?? "?").padEnd(14)}  ${moved}${v.restorable ? "" : dim("  (hashes only)")}`;
}

type Deps = { cliPost: Post; realCwd: () => string; readWorkspace?: (team?: string) => Promise<Workspace> };

const TEAM_OPTION = ["--team <name>", "The team whose flow it is (default: yours, else the workspace this directory reads)"] as const;

/** A flow's id in a workspace's library, which names it to the server whoever pushed it; null when that library has no such slug. */
async function libraryFlowId(deps: Deps, slug: string, team?: string): Promise<{ id: string | null; where: string }> {
  const ws = await deps.readWorkspace!(team);
  const r = await deps.cliPost("/cli/workflows/pool", ws.kind === "team" ? { team_id: ws.teamId } : {}, { throwOnError: true });
  const hit = (r?.flows ?? []).find((f: { slug: string }) => f.slug === slug.replace(/\.cast$/, ""));
  return { id: hit ? String(hit._id) : null, where: ws.kind === "team" ? (ws.name ?? team ?? ws.teamId) : "your personal workspace" };
}

/**
 * One /cli/flows/versions call for a flow named by slug or id. The server knows
 * a slug only among the caller's own flows, so a teammate's flow is found by
 * its id in the team's library: --team names that library, and with no --team
 * the workspace this directory reads is tried when the slug is not the caller's.
 */
async function flowOp(deps: Deps, name: string, team: string | undefined, body: Record<string, unknown>): Promise<any> {
  const call = async (flow: string) => {
    const r = await deps.cliPost("/cli/flows/versions", { ...body, flow }, { throwOnError: true });
    if (r?.error) throw new Error(r.error);
    return r;
  };
  const isId = /^[a-z0-9]{32}$/.test(name);
  if (team && !isId && deps.readWorkspace) {
    const { id, where } = await libraryFlowId(deps, name, team);
    if (!id) throw new Error(`${where} has no flow ${name} in its library: cast flow ls --team ${team} lists it`);
    return call(id);
  }
  try {
    return await call(name);
  } catch (err) {
    if (isId || !deps.readWorkspace || !/^No flow /.test(err instanceof Error ? err.message : String(err))) throw err;
    const { id } = await libraryFlowId(deps, name).catch(() => ({ id: null }));
    if (!id) throw err;
    return call(id);
  }
}

async function versions(deps: Deps, flow: string, team?: string): Promise<{ slug: string; runs_from: string | null; versions: Version[] }> {
  return flowOp(deps, flow, team, { op: "versions" });
}

export function registerFlowVersionCommands(flow: Command, deps: Deps): void {
  // A flow the server does not know gets the command that lists the ones it does.
  const fail = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const missing = /^No flow (.+)$/.exec(message);
    console.error(missing ? notFoundLine("flow", missing[1]!, "cast flow ls") : message);
    process.exit(1);
  };

  flow
    .command("save <files...>")
    .description("Save each .cast file as its flow's next library version; the flow's runs read the library from then on")
    .action(async (files: string[]) => {
      try {
        const { filePushBody } = await import("./workflow/filePush.js");
        const { deviceId } = await import("./remote/device.js");
        for (const file of files) {
          const { slug, graph, body } = await filePushBody(path.resolve(deps.realCwd(), file), deviceId());
          const r = await deps.cliPost("/cli/workflows/upsert", { ...body, save: true, library: true }, { throwOnError: true });
          if (r?.error) throw new Error(`${file}: ${r.error}`);
          const { versions: vs } = await versions(deps, slug);
          const current = vs.find((v) => v.current);
          console.log(`${slug}  v${current?.n ?? vs[0]?.n ?? 1}  ${graph.nodes.size} stations  library`);
        }
      } catch (err) { fail(err); }
    });

  flow
    .command("versions <flow>")
    .description("A flow's versions, newest first; * marks the one its runs read")
    .option(...TEAM_OPTION)
    .option("--json", "Print them as JSON")
    .action(async (name: string, opts: { json?: boolean; team?: string }) => {
      try {
        const r = await versions(deps, name, opts.team);
        if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
        console.log(`${r.slug}  runs from ${r.runs_from ?? "its file where it has one, else the saved copy"}`);
        for (const v of r.versions) console.log(versionLine(v));
      } catch (err) { fail(err); }
    });

  flow
    .command("restore <flow> <version>")
    .description("Make an earlier version (v3, or its id) the flow's current one; its runs read it from the next run")
    .option(...TEAM_OPTION)
    .action(async (name: string, version: string, opts: { team?: string }) => {
      try {
        const r = await flowOp(deps, name, opts.team, { op: "restore", version });
        console.log(`${r.slug}  v${r.version} = v${r.restored}`);
      } catch (err) { fail(err); }
    });

  flow
    .command("pin <flow>")
    .description("Where a flow's runs read its graph: the library's current version, or the checkout's file")
    .option("--repo", "Runs read the .cast file in the run's checkout")
    .option("--library", "Runs read the library's current version, on every machine")
    .option(...TEAM_OPTION)
    .action(async (name: string, opts: { repo?: boolean; library?: boolean; team?: string }) => {
      if (!!opts.repo === !!opts.library) fail("Pass one of --repo (runs read the checkout's file) or --library (runs read the saved version)");
      try {
        const r = await flowOp(deps, name, opts.team, { op: "pin", to: opts.repo ? "repo" : "library" });
        console.log(`${r.slug}  runs from ${r.runs_from}`);
      } catch (err) { fail(err); }
    });
}
