// May a project-scope write land in this file? Asked of git, per file, before
// the driver plans any write inside a repository.
//
// A tracked file is refused unless the caller passes an explicit override. A
// background reconciler that edits a tracked CLAUDE.md dirties the tree on a
// schedule (this repo's deploy refuses a dirty tree), and the next `git add -A`
// publishes a machine-local binding to everyone who pulls, past every consent
// gate the binding went through. An untracked file that git does not ignore is
// one `git add -A` away from the same thing, so the default setting writes only
// files git ignores; the refusal names .git/info/exclude, which is not itself
// tracked, rather than .gitignore, which is.
//
// The device setting `capabilities.project_writes`:
//   off           no project writes at all
//   ignored_only  only files git ignores (default)
//   all           untracked files too; tracked ones still need the override

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "../proc.js";

export const PROJECT_WRITES_SETTINGS = ["off", "ignored_only", "all"] as const;
export type ProjectWritesSetting = (typeof PROJECT_WRITES_SETTINGS)[number];
export const DEFAULT_PROJECT_WRITES: ProjectWritesSetting = "ignored_only";

export type ProjectWriteVerdict =
  | { ok: true; overridden?: boolean }
  | { ok: false; reason: "project_writes_off" | "tracked" | "not_ignored"; detail: string };

/** The device setting from a config bag, defaulted; an unknown value reads as
 *  the default rather than as permission. */
export function projectWritesSetting(config: object | null | undefined): ProjectWritesSetting {
  const raw = (config as { capabilities?: { project_writes?: unknown } } | null | undefined)?.capabilities?.project_writes;
  return (PROJECT_WRITES_SETTINGS as readonly unknown[]).includes(raw) ? (raw as ProjectWritesSetting) : DEFAULT_PROJECT_WRITES;
}

function git(cwd: string, args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: r.status, stdout: String(r.stdout ?? "") };
}

/** The deepest existing directory at or above `p`: git needs a real cwd, and a
 *  target's directory may not exist yet. */
function existingDir(p: string): string {
  let dir = p;
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dir;
}

export function checkProjectWrite(
  file: string,
  opts: { setting?: ProjectWritesSetting; overrideTracked?: boolean; log?: (line: string) => void } = {},
): ProjectWriteVerdict {
  const setting = opts.setting ?? DEFAULT_PROJECT_WRITES;
  if (setting === "off") {
    return { ok: false, reason: "project_writes_off", detail: `project writes are off on this device; ${file} was not written` };
  }

  const cwd = existingDir(path.dirname(file));
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  // Outside any repository there is no commit to leak into.
  if (top.status !== 0) return { ok: true };
  const root = top.stdout.trim();
  const rel = path.relative(fs.realpathSync(root), path.join(fs.realpathSync(cwd), path.relative(cwd, file)));

  if (git(root, ["ls-files", "--error-unmatch", "--", rel]).status === 0) {
    if (opts.overrideTracked) {
      opts.log?.(`[capabilities] writing tracked ${rel} in ${root}: the change will show in git status and ship with the next commit`);
      return { ok: true, overridden: true };
    }
    return {
      ok: false,
      reason: "tracked",
      detail: `${rel} is tracked in ${root}; a write there would be committed and shared with everyone who pulls`,
    };
  }

  if (git(root, ["check-ignore", "-q", "--", rel]).status === 0) return { ok: true };
  if (setting === "all") return { ok: true };
  return {
    ok: false,
    reason: "not_ignored",
    detail: `${rel} is untracked but not ignored in ${root}; add it to .git/info/exclude to let codecast write it`,
  };
}
