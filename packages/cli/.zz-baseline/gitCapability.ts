/**
 * Host git capability cache.
 *
 * Some git subcommands codecast prefers do not exist on older binaries
 * (`merge-tree --write-tree` arrived in git 2.38). Version numbers are not the
 * authority: vendors backport, and a wrapper's `--version` can differ from the
 * binary that actually runs. So we run the preferred command, catch the narrow
 * "unknown option" rejection, fall back, and remember the answer per host in
 * `~/.codecast/git-capabilities.json` keyed by the git version string — the
 * rejection is then not paid on every CLI run, and an in-place git upgrade
 * changes the key so the capability is probed again by itself.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileAsync } from "./proc.js";
import { defaultConfigDir } from "./config/configDir.js";

export type GitCapability = "merge-tree-write-tree";

type CacheFile = { gitVersion: string; capabilities: Partial<Record<GitCapability, boolean>> };

export interface GitCapabilityStore {
  /**
   * Run `preferred`; if this host's git rejects the command it needs, record
   * that and run `fallback` instead — this run and every later one.
   */
  runWithFallback<T>(
    capability: GitCapability,
    preferred: () => Promise<T>,
    fallback: () => T,
    isUnsupportedError: (err: unknown) => boolean,
  ): Promise<T>;
}

function errorText(err: unknown): string {
  if (typeof err !== "object" || err === null) return err instanceof Error ? err.message : String(err);
  return ["message", "stderr", "stdout"]
    .map((key) => (err as Record<string, unknown>)[key])
    .map((value) => (typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : ""))
    .join("\n");
}

/** True when git rejected `merge-tree --write-tree` itself (pre-2.38), not the merge. */
export function isUnsupportedMergeTreeWriteTreeError(err: unknown): boolean {
  const text = errorText(err);
  return (
    /(?:unknown|invalid|unrecognized) option(?::|\s+)[`']?(?:--?)?write-tree[`']?(?:\s|$)/i.test(text) ||
    /(?:unknown rev|not a valid object name)\s+[`']?--write-tree[`']?/i.test(text) ||
    /usage:\s*git merge-tree\s+<base-tree>/i.test(text)
  );
}

function defaultCachePath(): string {
  const root = defaultConfigDir();
  return path.join(root, "git-capabilities.json");
}

async function readGitVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], { encoding: "utf-8", timeout: 10_000 });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

export function createGitCapabilityStore(
  opts: { cachePath?: string; gitVersion?: string } = {},
): GitCapabilityStore {
  const cachePath = opts.cachePath ?? defaultCachePath();
  // The promise, not the value: two probes in flight at once then share one
  // read instead of racing to build two caches.
  let cache: Promise<CacheFile> | undefined;

  const load = (): Promise<CacheFile> => {
    // Lazy: a store that is never asked costs no subprocess.
    cache ??= (async () => {
      const gitVersion = opts.gitVersion ?? (await readGitVersion());
      try {
        const parsed = JSON.parse(await fs.promises.readFile(cachePath, "utf-8")) as CacheFile;
        // A different git binary answers differently, so its answers are not ours.
        return parsed.gitVersion === gitVersion ? parsed : { gitVersion, capabilities: {} };
      } catch {
        return { gitVersion, capabilities: {} };
      }
    })();
    return cache;
  };

  const remember = async (capability: GitCapability, supported: boolean): Promise<void> => {
    const current = await load();
    if (current.capabilities[capability] === supported) return;
    current.capabilities[capability] = supported;
    try {
      await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
      await fs.promises.writeFile(cachePath, JSON.stringify(current));
    } catch {
      /* a cache we cannot write costs a re-probe, nothing else */
    }
  };

  return {
    async runWithFallback(capability, preferred, fallback, isUnsupportedError) {
      if ((await load()).capabilities[capability] === false) return fallback();
      try {
        const result = await preferred();
        await remember(capability, true);
        return result;
      } catch (err) {
        if (!isUnsupportedError(err)) throw err;
        await remember(capability, false);
        return fallback();
      }
    },
  };
}
