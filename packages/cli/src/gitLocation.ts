// Where a checkout sits, as the daemon tells the server when it syncs a session (git_root, git_remote_url): the server
// stamps a session's team from these (convex privacy.ts resolveTeamForPath), so `cast flow` reads a directory's
// workspace from the same answer (directoryTeam.ts).
import { execFile } from "./proc.js";
import { checkoutOfMoveClone } from "./remote/session-move.js";

/** The checkout a session's repository is: a worktree's main checkout, a move clone's host checkout, else the toplevel. */
export function repoCheckoutRoot(commonDir: string | undefined, toplevel: string | undefined): string | undefined {
  const root = commonDir?.endsWith("/.git") ? commonDir.slice(0, -5) : toplevel;
  return root && checkoutOfMoveClone(root);
}

export function execGitIn(projectPath: string, args: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("git", args.split(" "), {
      cwd: projectPath,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    }, (err, stdout) => resolve(err ? undefined : String(stdout).trim()));
  });
}

/** Where a checkout sits: its root, its main checkout's root and its origin. Two git calls, no status or diff. */
export async function getGitLocation(projectPath: string): Promise<{ root: string; repoRoot: string | undefined; remoteUrl: string | undefined } | undefined> {
  const [paths, remoteUrl] = await Promise.all([
    execGitIn(projectPath, "rev-parse --show-toplevel --path-format=absolute --git-common-dir"),
    execGitIn(projectPath, "remote get-url origin"),
  ]);
  const [root, commonDir] = paths?.split("\n") ?? [];
  return root ? { root, repoRoot: repoCheckoutRoot(commonDir, root), remoteUrl } : undefined;
}
