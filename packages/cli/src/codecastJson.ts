// Writing a product's codecast.json from `cast sources add` and `key rotate`
// (docs/architecture/external-data.md X1, "Committed config"). The schema and
// the merge are @codecast/shared/contracts/codecastConfig; this is only where
// the file is and the read-merge-write around it.
import fs from "node:fs";
import path from "node:path";
import {
  CODECAST_CONFIG_FILE,
  formatCodecastConfig,
  mergeCodecastConfig,
  parseCodecastConfig,
  type CodecastConfigSource,
} from "@codecast/shared/contracts/codecastConfig";

/** The checkout root above `dir` (the nearest directory holding .git), or null outside a checkout. */
function checkoutRoot(dir: string): string | null {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, ".git"))) return at;
    if (path.dirname(at) === at) return null;
  }
}

/**
 * Which codecast.json a source lands in. `--write <path>` names it (a
 * directory means its codecast.json); `--no-write` (false) means none.
 * Otherwise the nearest existing codecast.json from `cwd` up to the checkout
 * root, else one at the root; outside a checkout, none.
 */
export function codecastJsonPath(cwd: string, write: string | boolean | undefined): string | null {
  if (write === false) return null;
  if (typeof write === "string" && write.trim()) {
    const target = path.resolve(cwd, write.trim());
    return fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, CODECAST_CONFIG_FILE) : target;
  }
  const root = checkoutRoot(cwd);
  if (!root) return null;
  for (let at = path.resolve(cwd); ; at = path.dirname(at)) {
    const file = path.join(at, CODECAST_CONFIG_FILE);
    if (fs.existsSync(file)) return file;
    if (at === root || path.dirname(at) === at) break;
  }
  return path.join(root, CODECAST_CONFIG_FILE);
}

export type WriteOutcome = { path: string; changes: string[] } | { path: string; error: string };

/** Merge a source (and a keyed source's key) into the file, creating it if needed. Never overwrites a file it cannot read. */
export function writeCodecastJson(
  file: string,
  add: { name: string; source: CodecastConfigSource; ingestKey?: string; endpoint?: string },
): WriteOutcome {
  let existing = null;
  if (fs.existsSync(file)) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return { path: file, error: "is not JSON; left as it is" };
    }
    const parsed = parseCodecastConfig(raw);
    if (!parsed.ok) return { path: file, error: `${parsed.errors.join("; ")}; left as it is` };
    existing = parsed.config;
  }
  const { config, changes } = mergeCodecastConfig(existing, add);
  if (changes.length) fs.writeFileSync(file, formatCodecastConfig(config));
  return { path: file, changes };
}

/** The ingestKey of the codecast.json `cast sources add` would write to from `cwd`, if it has one. */
export function committedIngestKey(cwd: string): string | undefined {
  const file = codecastJsonPath(cwd, undefined);
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    const parsed = parseCodecastConfig(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.ok ? parsed.config.ingestKey : undefined;
  } catch {
    return undefined;
  }
}
