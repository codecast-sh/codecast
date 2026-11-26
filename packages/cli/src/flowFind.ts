// Finding a flow by name for `cast flow` (flowCommand.ts): the pool this session sees (the repo's, the shipped, and the
// workspace's published flows, flows.md FL2), a flow written on stdin, or a .cast file by path.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import { notFoundLine } from "./argChecks.js";
import { retiredFlowLine, shipFlowSlug, workspacePool } from "@codecast/shared/contracts/flowPool";
import { describeFlow, poolFlows, workspaceDefaultFlow, type PoolFlow, type PushedPoolRow } from "./workflow/flowPool.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./workflow/templates.js";
import type { DirectoryWorkspace } from "./directoryTeam.js";
import type { FlowDeps } from "./flowCommand.js";

export type FoundFlow = PoolFlow & { source: string };

/** A session's 7-character codecast id, from whatever id the caller holds (its codecast id, or its agent's session id). */
export async function shortSessionId(session: string | null, deps: FlowDeps): Promise<string | null> {
  if (!session) return null;
  if (/^jx[a-z0-9]{5,}$/.test(session)) return session.slice(0, 7);
  const { readLocalConversationMap } = await import("./localConversationMap.js");
  const conv = readLocalConversationMap()[session];
  return conv ? String(conv).slice(0, 7) : session.slice(0, 8);
}

/**
 * The workspace a flow read names (flows.md FL2): the team given, else the one this directory's sessions are stamped
 * into (directoryTeam.ts: the web's Ship reads the same), which is personal only when that is established.
 */
export type PoolAt = Promise<DirectoryWorkspace>;
export async function poolWorkspace(deps: FlowDeps, team?: string, subjects?: () => Promise<ReadonlyArray<string>>): PoolAt {
  if (team) return { ws: await deps.readWorkspace(team), ownsDefault: true, personal: false };
  return deps.directoryWorkspace(subjects);
}

/** The flows published to the workspace's pool (/cli/workflows/pool, flows.md FL2), and the default flow this directory takes from it. */
export async function fetchPool(deps: FlowDeps, at: PoolAt): Promise<{ flows: PushedPoolRow[]; default_flow: string | null }> {
  const { ws, ownsDefault } = await at;
  const r = await deps.cliPost("/cli/workflows/pool", ws.kind === "team" ? { team_id: ws.teamId } : {}, { throwOnError: true });
  return { flows: r?.flows ?? [], default_flow: ownsDefault ? r?.default_flow ?? null : null };
}

/** The pool as this session sees it (the repo's, the shipped, and the workspace's published flows, in the workspace's
 *  terms: workspacePool), and the workspace's default flow in it: the one a nameless `cast flow run` runs. `failed`
 *  says why the workspace's pool could not be read: the local flows still list, but no default can be told from them. */
export async function readPool(deps: FlowDeps, at: PoolAt): Promise<{ flows: PoolFlow[]; library: PoolFlow[]; defaultFlow: PoolFlow | null; libraryDefault: PoolFlow | null; failed: string | null }> {
  const read = await fetchPool(deps, at).then(
    (r) => ({ ...r, failed: null }),
    (err: unknown) => ({ flows: [], default_flow: null, failed: err instanceof Error ? err.message : String(err) }),
  );
  const personal = await at.then((a) => a.personal, () => false);
  // `library` is every flow by its own name, before the workspace swaps the personal Ship in for `change` (--library).
  const library = poolFlows(deps.realCwd(), await shortSessionId(deps.callingSession() ?? null, deps), read.flows);
  const flows = workspacePool(library, personal);
  return { flows, library, defaultFlow: read.failed ? null : workspaceDefaultFlow(flows, read.default_flow), libraryDefault: read.failed ? null : workspaceDefaultFlow(personal ? library : workspacePool(library, false), read.default_flow), failed: read.failed };
}

export async function findFlow(slug: string, deps: FlowDeps, pool?: PoolFlow[], opts: { exact?: boolean } = {}): Promise<FoundFlow> {
  if (slug === "-") {
    // A graph this session writes now: kept in the checkout as its draft, the library flows it names pinned beside it.
    const { readStdin, writeSessionFlow } = await import("./workflow/sessionFlow.js");
    const text = readStdin();
    if (!text.trim()) { console.error("No graph on stdin: pipe a flow's digraph in, e.g. cast flow run - <<'EOF' ... EOF"); process.exit(1); }
    const top = (spawnSync("git", ["-C", deps.realCwd(), "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).stdout ?? "").trim() || deps.realCwd();
    try {
      const kept = writeSessionFlow(top, text, await shortSessionId(deps.callingSession() ?? null, deps), (pool ?? (await readPool(deps, poolWorkspace(deps))).flows));
      return { ...describeFlow(kept.slug, kept.source, "repo", kept.file), source: kept.source };
    } catch (err) {
      console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  const abs = path.resolve(deps.realCwd(), slug);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    const source = fs.readFileSync(abs, "utf-8");
    return { ...describeFlow(path.basename(abs).replace(/\.cast$/, ""), source, "repo", abs), source };
  }
  // `change` in a personal workspace's pool is its personal Ship (workspacePool), unless the name is meant exactly.
  const flows = pool ?? (await readPool(deps, poolWorkspace(deps))).flows;
  const name = slug.replace(/\.cast$/, "");
  const f = flows.find((p) => p.slug === (opts.exact ? name : shipFlowSlug(flows, name)));
  if (!f) {
    const retired = retiredFlowLine(slug.replace(/\.cast$/, ""));
    console.error(retired ? `✗ ${retired}` : notFoundLine("flow", slug, "cast flow ls"));
    process.exit(1);
  }
  return { ...f, source: f.file ? fs.readFileSync(f.file, "utf-8") : BUILTIN_WORKFLOW_TEMPLATES[f.slug] };
}
