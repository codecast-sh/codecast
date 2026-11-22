// This checkout's own flows, reported so the web's Ship picker shows what `cast flow run <slug>` runs here (convex
// repoFlows.ts, shared/contracts/repoFlows.ts): the `.codecast/flows` graphs poolFlows puts ahead of the shipped and
// published ones, parsed with `extends` expanded, under the repository its origin names. Sent from the session-start
// reads (stableContext.ts), and only when they changed since this machine last sent that repository's.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileAsync } from "../proc.js";
import { repositoryKeyOfRemote } from "@codecast/shared/contracts";
import type { RepoFlow, RepoFlowsReport } from "@codecast/shared/contracts/repoFlows";
import { flowGraphAttr } from "@codecast/shared/contracts/flowPool";
import { repoFlowsDir } from "./flowPool.js";
import { flowSnapshot } from "./shippedFlows.js";

/** The report for the checkout at `cwd`, or null when it has no origin remote to name its repository by. */
export function repoFlowsReport(cwd: string, remote: string | null): RepoFlowsReport | null {
  const repository = repositoryKeyOfRemote(remote);
  if (!repository) return null;
  const dir = repoFlowsDir(cwd);
  const flows: RepoFlow[] = [];
  for (const f of dir ? fs.readdirSync(dir).filter((f) => f.endsWith(".cast")).sort() : []) {
    const file = path.join(dir!, f);
    const src = fs.readFileSync(file, "utf-8");
    // A draft is its session's alone (poolFlows).
    if (flowGraphAttr(src, "draft")) continue;
    let snap: ReturnType<typeof flowSnapshot>;
    // A graph that does not parse has nothing to draw.
    try { snap = flowSnapshot(f.replace(/\.cast$/, ""), src, "repo", file); } catch { continue; }
    if (!snap.nodes.length) continue;
    flows.push({ slug: snap.slug, name: snap.name, kind: snap.kind, label: snap.label, description: snap.description, takes: snap.takes, nodes: snap.nodes as RepoFlow["nodes"], edges: snap.edges });
  }
  const hash = createHash("sha256").update(JSON.stringify(flows)).digest("hex").slice(0, 16);
  return { repository, hash, flows };
}

/** The checkout's origin remote, read without holding the event loop: this runs in the daemon's warmer too. */
async function originOf(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf-8", timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Send the checkout's report when it differs from what this machine last sent for its repository (`cacheDir` holds
 * that hash). A repository with no flows is sent once, so a row left by flows since removed goes away.
 */
export async function reportRepoFlows(cwd: string, post: (report: RepoFlowsReport) => Promise<boolean>, cacheDir: string): Promise<"sent" | "unchanged" | "skipped"> {
  const report = repoFlowsReport(cwd, await originOf(cwd));
  if (!report) return "skipped";
  const mark = path.join(cacheDir, `${createHash("sha256").update(report.repository).digest("hex").slice(0, 16)}.hash`);
  try { if (fs.readFileSync(mark, "utf-8") === report.hash) return "unchanged"; } catch { /* never sent */ }
  if (!(await post(report))) return "skipped";
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(mark, report.hash);
  return "sent";
}
