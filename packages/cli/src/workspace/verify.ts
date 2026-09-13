/**
 * `cast workspace check`: the one place the repo's check command runs from
 * the manifest ([verify] command). The line's verify station calls it in the
 * implement worktree; a person can run it by hand. No command configured is
 * not a failure: the caller prints that and exit 0 stands, so a repo without
 * a manifest still flows through the line.
 */
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { parseManifest } from "./manifest.js";
import { MANIFEST_REL_PATH } from "./resolver.js";

export function readVerifyCommand(repoRoot: string): string | null {
  const manifest = parseManifest(path.join(repoRoot, MANIFEST_REL_PATH));
  return manifest?.verify?.command ?? null;
}

export function runVerifyCommand(command: string, cwd: string): number {
  const r = spawnSync("bash", ["-c", command], { cwd, stdio: "inherit" });
  return r.status ?? 1;
}
