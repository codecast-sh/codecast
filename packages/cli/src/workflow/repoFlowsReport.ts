// This checkout's own flows, reported so the web's Ship picker shows what `cast flow run <slug>` runs here (convex
// repoFlows.ts, shared/contracts/repoFlows.ts): the `.codecast/flows` graphs poolFlows puts ahead of the shipped and
// published ones, parsed with `extends` expanded, under the checkout's git top level and the repository its origin
// names. Sent from the session-start reads (stableContext.ts) when they changed since this machine last sent this
// checkout's, and once a day regardless so the server knows the checkout is still there.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileAsync } from "../proc.js";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";
import type { RepoFlow, RepoFlowsReport } from "@codecast/shared/contracts/repoFlows";
import { flowGraphAttr } from "@codecast/shared/contracts/flowPool";
import { joinsPool, repoFlowsDir } from "./flowPool.js";
import { parseWorkflowSource } from "./parser.js";
import { decideStart, safeStartFacts } from "./startFacts.js";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./templates.js";
import { flowSnapshot } from "./shippedFlows.js";

/** How often an unchanged checkout reports anyway (convex repoFlows.ts prunes one silent for two weeks). */
export const RESEND_MS = 24 * 60 * 60 * 1000;

/** The report for the checkout whose top level is `root`, or null when it has no origin remote to name its repository by. */
export function repoFlowsReport(root: string, remote: string | null): RepoFlowsReport | null {
  const repository = repositoryKeyOfRemote(remote);
  if (!repository) return null;
  const dir = repoFlowsDir(root);
  const flows: RepoFlow[] = [];
  // Read as a run reads them (from the default branch); a default branch whose files do not parse decides nothing
  // here, and its runs refuse to start.
  const facts = safeStartFacts(root);
  for (const f of dir ? fs.readdirSync(dir).filter((f) => f.endsWith(".cast")).sort() : []) {
    const file = path.join(dir!, f);
    const src = fs.readFileSync(file, "utf-8");
    // A draft is its session's alone (poolFlows).
    if (flowGraphAttr(src, "draft")) continue;
    let snap: ReturnType<typeof flowSnapshot>;
    // A graph that does not parse has nothing to draw.
    try { snap = flowSnapshot(f.replace(/\.cast$/, ""), src, "repo", file, facts); } catch { continue; }
    if (!snap.nodes.length) continue;
    flows.push({ slug: snap.slug, name: snap.name, kind: snap.kind, label: snap.label, description: snap.description, takes: snap.takes, nodes: snap.nodes as RepoFlow["nodes"], edges: snap.edges });
  }
  // A shipped flow whose start this checkout decides another way (its ship mode) runs here as that path alone: the
  // picker shows it so, marked as the library's own (web flowPool buildPool).
  for (const [slug, src] of Object.entries(BUILTIN_WORKFLOW_TEMPLATES)) {
    if (flows.some((f) => f.slug === slug) || !joinsPool(slug, src)) continue;
    const graph = parseWorkflowSource(src);
    if (decideStart(graph, facts) === graph) continue;
    const snap = flowSnapshot(slug, src, "repo", null, facts);
    flows.push({ slug: snap.slug, name: snap.name, kind: snap.kind, label: snap.label, description: snap.description, takes: snap.takes, nodes: snap.nodes as RepoFlow["nodes"], edges: snap.edges, decided_from: slug, facts: { ship_mode: facts.ship_mode } });
  }
  const hash = createHash("sha256").update(JSON.stringify({ root, repository, flows })).digest("hex").slice(0, 16);
  return { root, repository, hash, flows };
}

/** One git read, without holding the event loop: this runs in the daemon's warmer too. */
async function gitOut(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Send the checkout's report when it differs from what this machine last sent for it, or that was over a day ago
 * (`cacheDir` holds the hash, its mtime when it was sent). A checkout with no flows reports that too, so the picker
 * shows it none rather than another worktree's.
 */
export async function reportRepoFlows(cwd: string, post: (report: RepoFlowsReport) => Promise<boolean>, cacheDir: string, now = Date.now()): Promise<"sent" | "unchanged" | "skipped"> {
  const root = await gitOut(cwd, ["rev-parse", "--show-toplevel"]);
  const report = root ? repoFlowsReport(root, await gitOut(root, ["remote", "get-url", "origin"])) : null;
  if (!report) return "skipped";
  const mark = path.join(cacheDir, `${createHash("sha256").update(report.root).digest("hex").slice(0, 16)}.hash`);
  try {
    if (fs.readFileSync(mark, "utf-8") === report.hash && now - fs.statSync(mark).mtimeMs < RESEND_MS) return "unchanged";
  } catch { /* never sent */ }
  if (!(await post(report))) return "skipped";
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(mark, report.hash);
  return "sent";
}
