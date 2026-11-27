// The server's copy of a repository's line profile and deploy targets (line-profile.md LP3, deploys.md DP10) is
// published from a checkout of the default branch, and nothing else moves it: a change that lands a new
// .codecast/line.toml, deploy.toml or workspace.toml left the server on the old one until someone published by hand.
// A change run's Deploy station therefore republishes them from a clean worktree of the merged commit, made for it and
// removed after, naming the run's checkout as where the targets' deploys run (CODECAST_PUBLISH_ROOT, pipeline.ts
// publishedRoot): the run's checkout itself may never hold the commit (a shared checkout with others' edits is not kept
// level), and ct-102479 and ct-102537 ended with an order to publish by hand. A cast that does not know a key the files
// name would publish without it, so it publishes nothing and names the cast that can.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, gitTry } from "../wipSnapshot.js";

/** The files whose change alters what the server holds of the repository's line and its deploy targets. */
export function landsConfig(files: ReadonlyArray<string>): boolean {
  return files.some((f) => f === ".codecast/line.toml" || f === ".codecast/deploy.toml" || f === ".codecast/workspace.toml" || f.startsWith(".codecast/line/"));
}

/** A clean detached worktree of `sha` from `cwd`'s repository, handed to `fn` and removed after, whatever `fn` does. */
export async function withMergedTree<T>(cwd: string, sha: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-republish-"));
  try {
    await git(cwd, ["worktree", "add", "--detach", "--quiet", dir, sha]);
    return await fn(dir);
  } finally {
    await gitTry(cwd, ["worktree", "remove", "--force", dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The keys of a tree's .codecast files this cast does not read: a publish by it would drop them. */
export async function unknownKeys(dir: string): Promise<string[]> {
  const out: string[] = [];
  const { shipSpec } = await import("../land/shipCheckout.js");
  const { readDeployTargetEntries, deployTargetWarnings } = await import("../workspace/deployTargetsFile.js");
  const { loadLineProfile } = await import("../lineProfile.js");
  // workspace.toml refuses a key it does not know, so a parse that throws is one.
  let ship;
  try { ship = shipSpec(dir); } catch (err) { out.push(err instanceof Error ? err.message : String(err)); }
  if (ship) {
    try { out.push(...deployTargetWarnings(readDeployTargetEntries(dir, ship.deploy))); } catch (err) { out.push(err instanceof Error ? err.message : String(err)); }
  }
  try { out.push(...loadLineProfile(dir).warnings.filter((w) => /unknown key/i.test(w))); } catch (err) { out.push(err instanceof Error ? err.message : String(err)); }
  return out;
}

export type Published = { republished: "all" } | { republished: "targets" | "none"; why: string };

export type RepublishIO = {
  /** Run `fn` in a clean tree of the merged commit (withMergedTree). */
  tree: <T>(fn: (dir: string) => Promise<T>) => Promise<T>;
  /** What this cast would drop from the tree's files (unknownKeys). */
  unknown: (dir: string) => Promise<string[]>;
  /** Publish the tree's profile and targets: what was republished, and why the rest was not. */
  publish: (dir: string) => Promise<Published>;
  /** This cast's version, for the words when it is too old. */
  version: string;
};

/** Republish the merged commit's profile and targets. Resolves with the words for the station's last line. */
export async function republishLanded(sha: string, io: RepublishIO): Promise<string> {
  const short = sha.slice(0, 7);
  const not = "The line profile and deploy targets it changed were not republished";
  try {
    return await io.tree(async (dir) => {
      const unknown = await io.unknown(dir);
      if (unknown.length) {
        return `${not}: this cast (${io.version}) does not read ${unknown.length === 1 ? "a key" : "keys"} they name, and a publish by it drops ${unknown.length === 1 ? "it" : "them"} (${unknown[0]}${unknown.length > 1 ? `, and ${unknown.length - 1} more` : ""}). A cast released from ${short} or later publishes them: \`cast line profile --publish\` in a checkout at ${short}.`;
      }
      const done = await io.publish(dir);
      if (done.republished === "all") return "Republished the line profile and deploy targets it changed.";
      if (done.republished === "targets") return `Republished the deploy targets it changed; the line profile was not: ${done.why}.`;
      return `${not}: ${done.why}.`;
    });
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).trim().split("\n").pop()?.slice(0, 200) ?? "";
    return `${not}: a worktree of ${short} could not be made (${why}). \`cast line profile --publish\` in a checkout at ${short} publishes them.`;
  }
}
