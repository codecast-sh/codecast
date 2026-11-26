// Whether the installed Claude Code honors CLAUDE_SECURESTORAGE_CONFIG_DIR
// (ccAccounts.ts, "Per-profile credential stores"). A version that ignores it
// silently runs every pinned session on the keychain login, so the daemon asks
// the binary: with the store pointed at an empty directory, `auth status` must
// report no login.
//
// Three answers, not two. A binary that reports a keychain login from an empty
// store is proved "unsupported"; a probe that crashed, timed out or printed
// something other than JSON proves nothing and answers "unknown". On 2026-09-17
// a first-run timeout of a freshly installed binary was recorded as a permanent
// "unsupported"; the daemon then deleted every profile store on every beat, and
// each browser sign-in a person completed was erased seconds later.
//
// Only a login the store itself would hold proves it was ignored. Claude Code
// also signs in from an Anthropic Console profile (~/.config/anthropic, moved
// by ANTHROPIC_CONFIG_DIR) and from token and key variables; any of those
// answers `loggedIn: true` with its own authMethod and says nothing about the
// store (2026-11-25: a Console login marked a current Claude Code
// "unsupported"). So the probe empties them, and a login by any method other
// than the keychain's "claude.ai" is unknown.
//
// Answers are cached by binary identity (path, size, mtime): a proved one for
// an hour, an unknown for ten minutes. The path a daemon launches is often a
// launcher script that execs the newest installed version, so its identity
// never changes when Claude Code updates; without an expiry one wrong answer
// outlived every update on such a machine. An unknown replaces an older
// negative, so a negative the latest probe could not confirm never deletes a
// store, and a machine whose settings sign Claude Code in some other way (an
// apiKeyHelper, Bedrock) is not asked on every beat. It never replaces a
// current proof of support: a probe that runs out of time on a cold first run
// proves nothing against it.
//
// Runs on the daemon's beat, so every filesystem call is async.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { STORE_OUTRANKING_ENV } from "./processEnv.js";
import { defaultConfigDir } from "./config/configDir.js";

export type SecureStorageVerdict = "supported" | "unsupported" | "unknown";

const PROVED_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_TTL_MS = 10 * 60 * 1000;

type CacheEntry = { identity: string; verdict: SecureStorageVerdict; checked_at: number };

/** The cached entry for `identity` that is still current at `at`, or null. A
 *  check time ahead of `at` (a clock that stepped back) is not current. */
async function readCurrent(cachePath: string, identity: string, at: number): Promise<CacheEntry | null> {
  try {
    const c = JSON.parse(await fs.promises.readFile(cachePath, "utf-8"));
    const verdict: unknown = c?.verdict;
    if (c?.identity !== identity || (verdict !== "supported" && verdict !== "unsupported" && verdict !== "unknown")) return null;
    const ttl = verdict === "unknown" ? UNKNOWN_TTL_MS : PROVED_TTL_MS;
    if (typeof c.checked_at !== "number" || c.checked_at > at || at - c.checked_at >= ttl) return null;
    return c as CacheEntry;
  } catch {
    return null;
  }
}

export async function probeSecureStorageSupport(
  claudeBin: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    execImpl?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
    /** Ask the binary even when a cached answer is current. */
    fresh?: boolean;
    timeoutMs?: number;
    now?: number;
  } = {},
): Promise<SecureStorageVerdict> {
  const now = opts.now ?? Date.now();
  const cachePath = path.join(defaultConfigDir(), "cc-store", ".support.json");
  let identity = claudeBin;
  try {
    const st = await fs.promises.stat(claudeBin);
    identity = `${claudeBin}:${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {}
  if (!opts.fresh) {
    const cached = await readCurrent(cachePath, identity, now);
    if (cached) return cached.verdict;
  }
  const probeDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cc-store-probe-"));
  let verdict: SecureStorageVerdict = "unknown";
  try {
    const consoleDir = path.join(probeDir, "anthropic");
    await fs.promises.mkdir(consoleDir);
    const env: NodeJS.ProcessEnv = {
      ...(opts.env ?? process.env),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: probeDir,
      ANTHROPIC_CONFIG_DIR: consoleDir,
    };
    for (const key of STORE_OUTRANKING_ENV) delete env[key];
    const exec =
      opts.execImpl ??
      (async (bin: string, args: string[], e: NodeJS.ProcessEnv) => {
        const { execFile } = await import("./proc.js");
        // `auth status` exits non-zero when nobody is signed in — which is the
        // answer we are hoping for — so the output is the verdict, not the code.
        return new Promise<string>((resolve, reject) => {
          execFile(bin, args, { env: e, encoding: "utf-8", timeout: opts.timeoutMs ?? 30_000 }, (err, stdout) =>
            err && !stdout ? reject(err) : resolve(stdout),
          );
        });
      });
    const status = JSON.parse(await exec(claudeBin, ["auth", "status", "--json"], env));
    // Anything but a real boolean is a binary that answered in a shape we do
    // not understand — that is an unknown, never a negative. A login that names
    // no authMethod is read as the keychain's, as it was before methods existed.
    if (status?.loggedIn === false) verdict = "supported";
    else if (status?.loggedIn === true && (status.authMethod === "claude.ai" || status.authMethod === undefined)) verdict = "unsupported";
  } catch {
    verdict = "unknown";
  } finally {
    await fs.promises.rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
  // Read again: another probe, perhaps one that started after this one, may
  // have proved support meanwhile.
  if (verdict === "unknown" && (await readCurrent(cachePath, identity, Math.max(now, Date.now())))?.verdict === "supported") {
    return "supported";
  }
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const tmp = `${cachePath}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ identity, verdict, checked_at: now }), { mode: 0o600 });
    await fs.promises.rename(tmp, cachePath);
  } catch {}
  return verdict;
}
