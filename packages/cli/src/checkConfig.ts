/**
 * `.codecast/check.toml`: which programs a tree carries (`[projects]`, name =
 * tsconfig path) and what checks them (top-level `checker`). check.ts
 * re-exports all of it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CHECK_CONFIG_REL_PATH } from "./checkConfigPath.js";

/** One program to check: its name (a path segment of the state dir) and its tsconfig, relative to the tree root. */
export interface CheckProject {
  name: string;
  tsconfig: string;
}

/** The parsed `.codecast/check.toml`, or null when the tree has none. */
function readCheckToml(root: string): Record<string, unknown> | null {
  const file = path.join(root, CHECK_CONFIG_REL_PATH);
  if (!fs.existsSync(file)) return null;
  try {
    return Bun.TOML.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`${CHECK_CONFIG_REL_PATH}: invalid TOML: ${(err as Error).message}`);
  }
}

/** The `[projects]` table of `.codecast/check.toml`, or null when the tree has none. */
export function readCheckConfig(root: string): CheckProject[] | null {
  const raw = readCheckToml(root);
  if (!raw) return null;
  readChecker(root, raw);
  const projects = raw.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    throw new Error(`${CHECK_CONFIG_REL_PATH}: expected a [projects] table of name = "path/to/tsconfig.json"`);
  }
  const out: CheckProject[] = [];
  for (const [name, tsconfig] of Object.entries(projects as Record<string, unknown>)) {
    if (typeof tsconfig !== "string" || !tsconfig.trim()) throw new Error(`${CHECK_CONFIG_REL_PATH}: projects.${name} must be a tsconfig path`);
    if (name === "checker") throw new Error(`${CHECK_CONFIG_REL_PATH}: checker is a top-level key; move it above [projects]`);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`${CHECK_CONFIG_REL_PATH}: project name '${name}' may use letters, digits, dot, dash and underscore only`);
    out.push({ name, tsconfig });
  }
  return out;
}

/** What checks the tree: a tsc watcher per project, or, with top-level `checker = "bun"`, one `bun check` per ask (checkBun.ts). */
export type Checker = "tsc" | "bun";

export function readChecker(root: string, raw = readCheckToml(root)): Checker {
  const checker = raw?.checker;
  if (checker === undefined || checker === "tsc" || checker === "bun") return checker ?? "tsc";
  throw new Error(`${CHECK_CONFIG_REL_PATH}: checker must be "tsc" or "bun", not ${JSON.stringify(checker)}`);
}
