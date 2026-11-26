// The server's copy of a repository's line profile and deploy targets (line-profile.md LP3, deploys.md DP10) is
// published from a checkout of the default branch, and nothing else moves it: a change that lands a new
// .codecast/line.toml, deploy.toml or workspace.toml left the server on the old one until someone published by hand.
// A change run's Deploy station therefore republishes them once the run's checkout holds the merged commit with its
// .codecast clean, the state a publish accepts (pipeline.ts publishRefusal), and says so on its last line.
import { gitTry } from "../wipSnapshot.js";

/** The files whose change alters what the server holds of the repository's line and its deploy targets. */
export function landsConfig(files: ReadonlyArray<string>): boolean {
  return files.some((f) => f === ".codecast/line.toml" || f === ".codecast/deploy.toml" || f === ".codecast/workspace.toml" || f.startsWith(".codecast/line/"));
}

/** Why the checkout cannot publish the merged commit's files yet, or null when it can. */
export async function notYetHeld(cwd: string, sha: string): Promise<string | null> {
  if ((await gitTry(cwd, ["merge-base", "--is-ancestor", sha, "HEAD"])) === null) return `the checkout's HEAD does not hold ${sha.slice(0, 7)} yet`;
  const dirty = await gitTry(cwd, ["status", "--porcelain", "--", ".codecast"]);
  if (dirty === null) return "git status could not read .codecast";
  if (dirty.trim()) return "the checkout's .codecast has uncommitted edits";
  return null;
}

export type Published = { republished: "all" } | { republished: "targets" | "none"; why: string };

export type RepublishIO = {
  /** Why the checkout cannot publish yet, or null (notYetHeld). */
  held: () => Promise<string | null>;
  /** Publish the checkout's profile and targets: what was republished, and why the rest was not. */
  publish: () => Promise<Published>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/**
 * Republish once the checkout holds the merged commit, looking every `intervalMs` until `deadline` (a time from
 * `io.now`). Resolves with the words for the station's last line. A checkout the daemon keeps level holds a landed
 * commit within a minute or two; one that never does is named, with the command that publishes by hand.
 */
export async function republishLanded(cwd: string, sha: string, io: RepublishIO, opts: { intervalMs: number; deadline: number }): Promise<string> {
  let why = "";
  for (;;) {
    const blocked = await io.held();
    if (!blocked) {
      const done = await io.publish();
      if (done.republished === "all") return "Republished the line profile and deploy targets it changed.";
      if (done.republished === "targets") return `Republished the deploy targets it changed; the line profile was not: ${done.why}.`;
      return `The line profile and deploy targets it changed were not republished: ${done.why}.`;
    }
    why = blocked;
    if (io.now() >= opts.deadline) break;
    await io.sleep(opts.intervalMs);
  }
  return `The line profile and deploy targets it changed were not republished: ${why}. Run \`cast line profile --publish\` in ${cwd} once it holds ${sha.slice(0, 7)}.`;
}
