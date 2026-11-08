import { execFile } from "child_process";

/**
 * True only when git itself says `cwd` is outside any repository. A timeout, a
 * missing folder, a missing git binary or a repo with no commits yet answer
 * false: the caller clears a recorded git_root on true, and a guess must never
 * erase a real one.
 */
export function isOutsideGitRepo(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf-8", timeout: 10_000 }, (err, _stdout, stderr) => {
      resolve(!!err && (err as { code?: unknown }).code === 128 && /not a git repository/i.test(String(stderr)));
    });
  });
}
