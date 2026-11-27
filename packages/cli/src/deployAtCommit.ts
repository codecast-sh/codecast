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

/** Whether this checkout has the commit at all (a deploy of a sha it never fetched has nothing here to read). */
export async function hasCommit(root: string, sha: string): Promise<boolean> {
  return (await gitTry(root, ["cat-file", "-e", `${sha}^{commit}`])) !== null;
}

const SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?\/?(?:[\w/]*\/)?(?:ba)?sh\b/;

/**
 * The command a step runs, with the script it starts read from `sha` when the checkout's HEAD does not hold `sha` and
 * its copy differs: `bash -c "$CAST_DEPLOY_SCRIPT" <path> <args>`, so the script's `$0` is still its path from the
 * root. Only a shell script is swapped; any other command runs as written, and `said` names why.
 */
export async function commandAtCommit(root: string, sha: string, command: string): Promise<{ command: string; env: Record<string, string>; said: string | null }> {
  const asIs = { command, env: {}, said: null };
  if (await headHolds(root, sha)) return asIs;
  if (!(await hasCommit(root, sha))) return asIs;
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
  const short = sha.slice(0, 7);
  const head = (await gitTry(root, ["rev-parse", "--short=7", "HEAD"]))?.trim() ?? "HEAD";
  const shebang = text.split("\n", 1)[0];
  if (shebang.startsWith("#!") && !SHELL_SHEBANG.test(shebang)) {
    return { ...asIs, said: `This checkout (at ${head}) is behind ${short} and its ${rel} differs from ${short}'s, which is not a shell script, so the checkout's copy runs.` };
  }
  return {
    command: `bash -c "$CAST_DEPLOY_SCRIPT" ${rel.includes("'") ? rel : `'${rel}'`}${m![2]}`,
    env: { CAST_DEPLOY_SCRIPT: text },
    said: `This checkout (at ${head}) is behind ${short}: running ${rel} as ${short} has it.`,
  };
}
