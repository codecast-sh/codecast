// The server's copy of a repository's line profile and deploy targets (line-profile.md LP3, deploys.md DP10) is
// published from a checkout of the default branch, and nothing else moves it: a change that lands a new
// .codecast/line.toml, deploy.toml or workspace.toml left the server on the old one until someone published by hand.
// A change run's Deploy station therefore republishes them from a clean worktree of the merged commit, made for it and
// removed after, naming the run's checkout as where the targets' deploys run (CODECAST_PUBLISH_ROOT, pipeline.ts
// publishedRoot): the run's checkout itself may never hold the commit (a shared checkout with others' edits is not kept
// level), and ct-102479 and ct-102537 ended with an order to publish by hand. A cast that does not know a key the files
// name would publish without it, so the publish runs `--strict`: the cast that publishes judges, publishes nothing,
// and the station names the cast that can.
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

export type Published =
  | { republished: "all" }
  | { republished: "targets" | "none"; why: string }
  /** The cast that publishes does not read keys the files name (`--strict` exit 3): it published nothing. */
  | { republished: "refused"; version: string; unknown: string[]; needed: string | null };

export type RepublishIO = {
  /** Run `fn` in a clean tree of the merged commit (withMergedTree). */
  tree: <T>(fn: (dir: string) => Promise<T>) => Promise<T>;
  /** Publish the tree's profile and targets with `--strict`: what was republished, and why the rest was not. */
  publish: (dir: string) => Promise<Published>;
};

/**
 * The cast release that reads every key a tree of codecast's own repository names: the one after the version its
 * packages/cli/package.json holds (a release bumps main to its own version after it is cut, so a commit past that bump
 * goes out with the next). Null for any other repository, whose commits say nothing of cast's versions.
 */
export function castVersionNeeded(dir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "packages/cli/package.json"), "utf-8"));
    if (pkg?.name !== "@codecast/cli" || typeof pkg.version !== "string") return null;
    const parts = pkg.version.split(".").map(Number);
    if (parts.length !== 3 || parts.some((n: number) => !Number.isInteger(n))) return null;
    return `v${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  } catch {
    return null;
  }
}

/** Republish the merged commit's profile and targets. Resolves with the words for the station's last line. */
export async function republishLanded(sha: string, io: RepublishIO): Promise<string> {
  const short = sha.slice(0, 7);
  const not = "The line profile and deploy targets it changed were not republished";
  try {
    return await io.tree(async (dir) => {
      const done = await io.publish(dir);
      if (done.republished === "all") return "Republished the line profile and deploy targets it changed.";
      if (done.republished === "targets") return `Republished the deploy targets it changed; the line profile was not: ${done.why}.`;
      if (done.republished === "refused") {
        const n = done.unknown.length;
        return `${not}: the cast that publishes them (${done.version}) does not read ${n === 1 ? "a key" : `${n} keys`} they name and would drop ${n === 1 ? "it" : "them"} (${done.unknown[0]}). ${done.needed ? `cast ${done.needed} or later reads ${n === 1 ? "it" : "them"}` : "A newer cast that reads them publishes them"}: \`cast update\`, then \`cast line profile --publish\` in a checkout at ${short}.`;
      }
      return `${not}: ${done.why}.`;
    });
  } catch (err) {
    const why = (err instanceof Error ? err.message : String(err)).trim().split("\n").pop()?.slice(0, 200) ?? "";
    return `${not}: a worktree of ${short} could not be made (${why}). \`cast line profile --publish\` in a checkout at ${short} publishes them.`;
  }
}
