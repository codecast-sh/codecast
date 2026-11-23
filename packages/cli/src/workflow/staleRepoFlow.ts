// A flow found by name that the repo's default branch overrides: `cast flow run` refuses it, `show` warns.
import { spawnSync } from "../proc.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PoolFlow } from "./flowPool.js";

/**
 * Why a flow found by name must not run here: it came from the library or the
 * team's pool, while the repo's default branch holds its own
 * `.codecast/flows/<slug>.cast` and this checkout (cut before it landed) does
 * not. Both sides are read at the repo root. Null when the flow is the repo's
 * own, or outside a repo with a default branch. Reads only local refs.
 */
export function staleRepoFlow(f: Pick<PoolFlow, "slug" | "where">, cwd: string): string | null {
  if (f.where === "repo") return null;
  const git = (...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const top = git("rev-parse", "--show-toplevel").stdout?.trim();
  const rel = `.codecast/flows/${f.slug}.cast`;
  if (!top || fs.existsSync(path.join(top, rel))) return null;
  const head = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").stdout?.trim();
  const ref = head || ["origin/main", "origin/master"].find((r) => git("rev-parse", "--verify", "--quiet", `${r}^{commit}`).status === 0);
  if (!ref || git("cat-file", "-e", `${ref}:${rel}`).status !== 0) return null;
  return `This checkout predates the repo's own ${f.slug} flow (${ref} has ${rel}), so the library's would run instead. Rebase onto ${ref}, or run from a checkout that has it (--library runs the library's anyway).`;
}
