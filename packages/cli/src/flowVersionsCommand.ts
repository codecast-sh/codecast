// `cast flow save|versions|restore|pin` (ct-70169): where a flow's runs read
// its graph, and its versions. A flow in the library runs its current version
// on every machine; `save` switches a flow there from its file and saves
// later edits, `restore` writes an older version back as the current one,
// `pin --repo` makes its runs read the checkout's file again. The server's
// side is convex/flowVersions.ts.
import type { Command } from "commander";
import * as path from "node:path";

type Post = (urlPath: string, body: Record<string, any>, opts?: { timeoutMs?: number; throwOnError?: boolean }) => Promise<any>;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

type Version = { n: number; id: string; at: number; by: string | null; changed: string[]; restorable: boolean; current: boolean };

/** One version as a line: number, when, who, what moved, which runs read it now. */
export function versionLine(v: Version): string {
  const when = new Date(v.at).toISOString().slice(0, 16).replace("T", " ");
  const moved = v.changed.length ? v.changed.join(", ") : "no stations moved";
  return `${v.current ? "*" : " "} v${v.n}  ${when}  ${(v.by ?? "?").padEnd(14)}  ${moved}${v.restorable ? "" : dim("  (hashes only)")}`;
}

async function versions(post: Post, flow: string): Promise<{ slug: string; runs_from: string | null; versions: Version[] }> {
  const r = await post("/cli/flows/versions", { op: "versions", flow }, { throwOnError: true });
  if (r?.error) throw new Error(r.error);
  return r;
}

export function registerFlowVersionCommands(flow: Command, deps: { cliPost: Post; realCwd: () => string }): void {
  const fail = (err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); };

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
          const { versions: vs } = await versions(deps.cliPost, slug);
          const current = vs.find((v) => v.current);
          console.log(`${slug}  v${current?.n ?? vs[0]?.n ?? 1}  ${graph.nodes.size} stations  library`);
        }
      } catch (err) { fail(err); }
    });

  flow
    .command("versions <flow>")
    .description("A flow's versions, newest first; * marks the one its runs read")
    .option("--json", "Print them as JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const r = await versions(deps.cliPost, name);
        if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
        console.log(`${r.slug}  runs from ${r.runs_from ?? "its file where it has one, else the saved copy"}`);
        for (const v of r.versions) console.log(versionLine(v));
      } catch (err) { fail(err); }
    });

  flow
    .command("restore <flow> <version>")
    .description("Make an earlier version (v3, or its id) the flow's current one; its runs read it from the next run")
    .action(async (name: string, version: string) => {
      try {
        const r = await deps.cliPost("/cli/flows/versions", { op: "restore", flow: name, version }, { throwOnError: true });
        if (r?.error) throw new Error(r.error);
        console.log(`${r.slug}  v${r.version} = v${r.restored}`);
      } catch (err) { fail(err); }
    });

  flow
    .command("pin <flow>")
    .description("Where a flow's runs read its graph: the library's current version, or the checkout's file")
    .option("--repo", "Runs read the .cast file in the run's checkout")
    .option("--library", "Runs read the library's current version, on every machine")
    .action(async (name: string, opts: { repo?: boolean; library?: boolean }) => {
      if (!!opts.repo === !!opts.library) fail("Say one: --repo or --library");
      try {
        const r = await deps.cliPost("/cli/flows/versions", { op: "pin", flow: name, to: opts.repo ? "repo" : "library" }, { throwOnError: true });
        if (r?.error) throw new Error(r.error);
        console.log(`${r.slug}  runs from ${r.runs_from}`);
      } catch (err) { fail(err); }
    });
}
