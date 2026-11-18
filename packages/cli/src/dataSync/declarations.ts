// Which folders this machine's repos declare for data sync ([host] data in
// .codecast/workspace.toml). A declaration reaches the server once, from any
// machine that has the repo, and from then on every machine of the person
// syncs the folder, with the checkout or without it.

import { execFileSync } from "../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { dataFolderFromManifest } from "@codecast/shared/contracts/dataSync";
import { parseManifest } from "../workspace/manifest.js";

export interface Declaration { path: string; declared_by: string }

/** The git checkout holding `dir`, or null. */
export function repoRootOf(dir: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim() || null;
  } catch {
    return null;
  }
}

/** The folders `repoRoot`'s manifest declares, named after the repo. A missing or broken manifest declares nothing. */
export function declaredIn(repoRoot: string): Declaration[] {
  let data: string[] | undefined;
  try {
    data = parseManifest(path.join(repoRoot, ".codecast", "workspace.toml"))?.host?.data;
  } catch {
    return [];
  }
  const name = path.basename(repoRoot);
  return (data ?? []).flatMap((entry) => {
    const folder = dataFolderFromManifest(entry);
    return folder ? [{ path: folder, declared_by: name }] : [];
  });
}

/** The project folders of this machine's codecast panes (the `@codecast_project_path` each launch sets). */
export function paneProjectPaths(): string[] {
  try {
    const out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{@codecast_project_path}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    return [...new Set(out.split("\n").map((l) => l.trim()).filter((l) => l && fs.existsSync(l)))];
  } catch {
    return [];
  }
}

/** Every declaration in the repos holding these folders, once per folder. */
export function declarationsFor(dirs: string[]): Declaration[] {
  const roots = new Set(dirs.map(repoRootOf).filter((r): r is string => !!r));
  const seen = new Map<string, Declaration>();
  for (const root of roots) for (const d of declaredIn(root)) if (!seen.has(d.path)) seen.set(d.path, d);
  return [...seen.values()];
}
