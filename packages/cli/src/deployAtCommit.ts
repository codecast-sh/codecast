// A deploy's steps run in the checkout that publishes its target, which holds the env and installs its commands need.
// That checkout can sit behind the commit the deploy sends: a shared checkout holding other sessions' edits is not
// kept level with origin. Its copy of a send script is then an older one (dp-3775, dp-3782 and dp-3789 ran a
// cut-cli-release.sh that refused while a release was in flight, where main's waits for it). So a step of a deploy
// whose commit the checkout's HEAD does not hold runs the commands that commit declares, and a repository script
// they name as that commit has it, still from the checkout's root.
import { gitTry } from "./wipSnapshot.js";

/** Whether the checkout's HEAD holds `sha`: then its own files are at least as new as the deploy's. */
export async function headHolds(root: string, sha: string): Promise<boolean> {
  return (await gitTry(root, ["merge-base", "--is-ancestor", sha, "HEAD"])) !== null;
}

/** Whether this checkout has the commit, fetching origin once when it does not yet (a push it has not fetched). */
export async function hasCommit(root: string, sha: string): Promise<boolean> {
  const here = async () => (await gitTry(root, ["cat-file", "-e", `${sha}^{commit}`])) !== null;
  if (await here()) return true;
  await gitTry(root, ["fetch", "-q", "origin"]);
  return here();
}

/**
 * Whether this checkout must read the deploy's commit rather than its own files: its HEAD does not hold the commit.
 * `missing` when it lacks the commit even after a fetch, so its own files are all it has, and the step says so.
 */
export async function behindCommit(root: string, sha: string): Promise<"no" | "behind" | "missing"> {
  if (await headHolds(root, sha)) return "no";
  return (await hasCommit(root, sha)) ? "behind" : "missing";
}

const SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?\/?(?:[\w/]*\/)?(?:ba)?sh\b/;

/**
 * The command a step runs, with the script it starts read from `sha` when the checkout's HEAD does not hold `sha` and
 * its copy differs: `bash -c "$CAST_DEPLOY_SCRIPT" <path> <args>`, so the script's `$0` is still its path from the
 * root. Only a shell script is swapped; any other command runs as written, and `said` names why.
 */
export async function commandAtCommit(root: string, sha: string, command: string): Promise<{ command: string; env: Record<string, string>; said: string | null }> {
  const asIs = { command, env: {}, said: null };
  const where = await behindCommit(root, sha);
  if (where === "no") return asIs;
  const short = sha.slice(0, 7);
  const head = (await gitTry(root, ["rev-parse", "--short=7", "HEAD"]))?.trim() ?? "HEAD";
  if (where === "missing") return { ...asIs, said: `This checkout (at ${head}) does not hold ${short} and cannot fetch it from origin, so it runs its own copy of the command's files, which may be older.` };
  const m = command.trim().match(/^(\S+)([\s\S]*)$/);
  const file = m?.[1] ?? "";
  // A command, not a path in the repository (`cast …`, `bash -c …`, an absolute path, an env assignment).
  if (!file || file.startsWith("/") || file.startsWith("-") || file.includes("=") || !file.includes("/")) return asIs;
  const rel = file.replace(/^\.\//, "");
  const want = (await gitTry(root, ["rev-parse", "-q", "--verify", `${sha}:${rel}`]))?.trim();
  if (!want) return asIs;
  const have = (await gitTry(root, ["hash-object", "--", rel]))?.trim();
  if (have === want) return asIs;
  const text = await gitTry(root, ["show", `${sha}:${rel}`]);
  if (text === null) return asIs;
  const shebang = text.split("\n", 1)[0];
  if (shebang.startsWith("#!") && !SHELL_SHEBANG.test(shebang)) {
    return { ...asIs, said: `This checkout (at ${head}) is behind ${short} and its ${rel} differs from ${short}'s, which is not a shell script, so the checkout's copy runs.` };
  }
  // A script that runs itself again from disk (`exec … "$PWD/deploy.sh"`) leaves the commit's copy for the checkout's.
  const base = rel.split("/").pop()!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rerunsItself = new RegExp(`\\bexec\\b[^\\n]*(?:\\$0|${base})`).test(text);
  return {
    command: `bash -c "$CAST_DEPLOY_SCRIPT" ${rel.includes("'") ? rel : `'${rel}'`}${m![2]}`,
    env: { CAST_DEPLOY_SCRIPT: text },
    said: rerunsItself
      ? `This checkout (at ${head}) is behind ${short}: starting ${rel} as ${short} has it, but it runs itself again from this checkout's copy, which may be older.`
      : `This checkout (at ${head}) is behind ${short}: running ${rel} as ${short} has it.`,
  };
}
