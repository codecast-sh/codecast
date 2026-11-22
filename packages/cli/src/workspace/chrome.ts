/**
 * Per-workspace headless Chromium launcher.
 *
 * Spawns one Chrome instance per workspace with:
 *   - Unique CDP port for programmatic control (claude-in-chrome, Playwright, raw CDP)
 *   - Isolated user-data-dir so cookies/localStorage don't bleed across workspaces
 *   - Headless mode by default; non-headless available for visual debugging
 *
 * Design choices:
 *   - We do NOT bundle a Chromium binary. On macOS we run codecast's own
 *     Chrome for Testing, downloaded on first need (automationChromeBinary);
 *     elsewhere, and until it lands, we discover the system's Chrome by
 *     probing well-known paths and the PATH env. Users on machines without
 *     Chrome get a clear error.
 *   - The launched process is detached so it survives a daemon restart, but we
 *     persist its pid so we can SIGTERM it on workspace release.
 *   - --remote-debugging-port=0 would let Chrome pick a free port but we'd
 *     have to parse it from DevToolsActivePort file. Instead we get a
 *     pre-validated free port from the ports module (same primitive
 *     allocatePorts uses) and pass it explicitly.
 */

import { spawn, whichBin } from "../proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isPortFree } from "./ports.js";

export interface ChromeInstance {
  /** OS process id of the spawned Chromium. */
  pid: number;
  /** CDP port the instance is listening on (devtools protocol). */
  cdpPort: number;
  /** Isolated user-data-dir on disk. */
  userDataDir: string;
  /** Whether --headless=new was used. */
  headless: boolean;
  /** Resolved path to the Chromium binary that was launched. */
  binaryPath: string;
}

export interface LaunchChromeOptions {
  /** CDP port to bind. Should already be probed free. */
  cdpPort: number;
  /** Where to put the isolated profile. Created if absent. */
  userDataDir: string;
  /** Default true. Pass false for visual debugging. */
  headless?: boolean;
  /** Override binary path (else auto-detect). */
  binaryPath?: string;
  /** Max seconds to wait for CDP port to become listening. Default 20. */
  readyTimeoutSec?: number;
  /** Extra args appended after the standard set. */
  extraArgs?: string[];
}

export class ChromeNotFoundError extends Error {
  constructor(probed: string[]) {
    super(
      `Could not find a Chromium binary. Set CODECAST_CHROMIUM env var, or install Chrome/Chromium. Tried: ${probed.join(", ")}`,
    );
    this.name = "ChromeNotFoundError";
  }
}

export class ChromeLaunchError extends Error {
  constructor(message: string, public readonly pid?: number) {
    super(message);
    this.name = "ChromeLaunchError";
  }
}

export class ChromeStopError extends Error {
  constructor(public readonly pid: number, timeoutMs: number) {
    super(`Chromium (pid ${pid}) is still alive ${timeoutMs}ms after SIGKILL`);
    this.name = "ChromeStopError";
  }
}

/**
 * Resolve the Chromium/Chrome binary path. Returns null if none found
 * (callers should throw ChromeNotFoundError with the probe list).
 */
export function findChromeBinary(): string | null {
  const probes = chromeBinaryProbes();
  for (const p of probes) {
    try {
      if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) return p;
    } catch {
      /* ignore */
    }
  }
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const found = whichBin(name);
    if (found) return found;
  }
  return null;
}

const CFT_EXECUTABLE = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const CFT_RETRY_MS = 6 * 60 * 60 * 1000;

/** Where codecast keeps its own Chrome for Testing, one directory per version. */
export function chromeForTestingDir(home: string = os.homedir()): string {
  return path.join(home, ".codecast", "chrome-for-testing");
}

/** A Chrome app bundle's major version, from its Info.plist; 0 when unreadable. */
function bundleMajor(binary: string): number {
  const app = binary.indexOf(".app/");
  if (app < 0) return 0;
  try {
    const plist = fs.readFileSync(binary.slice(0, app + 5) + "Contents/Info.plist", "utf-8");
    return Number(plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)/)?.[1]) || 0;
  } catch {
    return 0;
  }
}

/**
 * The Chrome codecast launches for itself without a window and with a fresh
 * profile (a workspace's, a publish thumbnail's). On macOS every process
 * started from Google Chrome.app registers with LaunchServices as
 * com.google.Chrome, headless or not, and macOS hands a link the human clicks
 * in another app to any running instance: with workspace Chromes up, "Open
 * page" in the desktop app went to a headless one, which took focus with no
 * window to show and stayed in the app switcher as a second Chrome
 * (2026-11-21). Chrome for Testing registers under its own bundle id, so the
 * human's links never reach it. Codecast keeps its own copy and starts a
 * background download of the current stable one whenever none is installed or
 * it is a major version behind the human's Chrome; until the first download
 * lands, the human's Chrome is used and stderr says so. An explicit
 * CODECAST_CHROMIUM or CHROME_PATH still wins. Not for a headless `cast
 * browser`: its profile is cloned from the human's Chrome, whose cookies are
 * sealed with Google Chrome's keychain key, which Chrome for Testing cannot
 * open, and it empties the cookie store on its first start.
 */
export function automationChromeBinary(opts: {
  home?: string;
  platform?: NodeJS.Platform;
  install?: (dir: string, platformName: string) => void;
} = {}): string | null {
  if ((opts.platform ?? process.platform) !== "darwin" || process.env.CODECAST_CHROMIUM || process.env.CHROME_PATH) return findChromeBinary();
  const dir = chromeForTestingDir(opts.home);
  const platformName = process.arch === "arm64" ? "mac-arm64" : "mac-x64";
  let versions: string[] = [];
  try {
    versions = fs.readdirSync(dir).filter((v) => /^\d/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {}
  const installed = versions
    .map((v) => ({ major: parseInt(v, 10), binary: path.join(dir, v, `chrome-${platformName}`, CFT_EXECUTABLE) }))
    .find((c) => fs.existsSync(c.binary));
  const human = findChromeBinary();
  if (!installed || (human && installed.major < bundleMajor(human))) (opts.install ?? installChromeForTesting)(dir, platformName);
  if (installed) return installed.binary;
  process.stderr.write(`Until Chrome for Testing is in ${dir}, this headless Chrome runs as Google Chrome and can catch links you open.\n`);
  return human;
}

/**
 * Download the current stable Chrome for Testing into `dir/<version>` in a
 * detached shell, at most once per CFT_RETRY_MS, and say so on stderr. The
 * build is unsigned, so HTTPS from Google's own bucket is its only check (as
 * for `npx @puppeteer/browsers`). The newest two versions are kept, so a
 * Chrome still running from the previous one keeps its files.
 */
export function installChromeForTesting(dir: string, platformName: string): void {
  const stamp = path.join(dir, ".attempted");
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < CFT_RETRY_MS) return;
  } catch {}
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stamp, "");
  } catch {
    return;
  }
  const script = `set -e
cd "$1"
v=$(curl -fsSL https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_STABLE)
case "$v" in [0-9]*.*) ;; *) exit 1 ;; esac
[ -d "$v" ] && exit 0
rm -rf ".partial-$v"; mkdir ".partial-$v"
curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/$v/$2/chrome-$2.zip" -o ".partial-$v/cft.zip"
ditto -x -k ".partial-$v/cft.zip" ".partial-$v"
rm ".partial-$v/cft.zip"
mv ".partial-$v" "$v"
ls | grep '^[0-9]' | sort -t. -k1,1nr -k2,2nr -k3,3nr -k4,4nr | tail -n +3 | while read -r old; do rm -rf "$old"; done`;
  try {
    const child = spawn("/bin/sh", ["-c", script, "chrome-for-testing", dir, platformName], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    process.stderr.write(`Downloading the current Chrome for Testing (about 150 MB) to ${dir} in the background.\n`);
  } catch {}
}

/** Probe list (in priority order). Exported for error reporting. */
export function chromeBinaryProbes(): string[] {
  const probes: string[] = [];
  for (const env of [process.env.CODECAST_CHROMIUM, process.env.CHROME_PATH]) if (env) probes.push(env);
  // macOS app bundles
  probes.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  probes.push("/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary");
  probes.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  // Linux package names
  probes.push("/usr/bin/google-chrome");
  probes.push("/usr/bin/google-chrome-stable");
  probes.push("/usr/bin/chromium");
  probes.push("/usr/bin/chromium-browser");
  // Snap (Linux)
  probes.push("/snap/bin/chromium");
  return probes;
}

/**
 * Keychain flags for a macOS launch.
 *
 * Chrome on macOS stores its cookie encryption key ("Chrome Safe Storage") in
 * the login keychain of the home directory it runs under. Under a home that
 * has no login keychain (a test sandbox, a scratch HOME) the Security
 * framework answers "no default keychain" (-25307) and macOS raises a modal
 * "Keychain Not Found" dialog on the desktop for every launch, blocking Chrome
 * until a person dismisses it. `--use-mock-keychain` makes Chrome keep the key
 * in memory instead, which is right for such a home: no keychain can exist
 * there. A real home keeps the real keychain, so profiles that already hold
 * encrypted cookies stay readable.
 */
export function keychainArgs(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin") return [];
  const home = env.HOME || os.homedir();
  const loginKeychain = path.join(home, "Library", "Keychains", "login.keychain-db");
  return fs.existsSync(loginKeychain) ? [] : ["--use-mock-keychain"];
}

/** Default args used for every launch. CDP + isolation + automation-friendly. */
function defaultArgs(opts: LaunchChromeOptions): string[] {
  return [
    `--remote-debugging-port=${opts.cdpPort}`,
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...keychainArgs(),
    // Disable Chrome's own update / metrics / telemetry side-channels.
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    // Reduce flakiness in CI/sandbox environments.
    "--disable-dev-shm-usage",
    "--disable-features=Translate,InterestFeedContentSuggestions",
    // Headful only, in effect: an occluded or backgrounded window otherwise
    // reports visibilityState "hidden" and freezes rAF, so WebGL never paints
    // and screenshots of it come back blank (see browser/instance.ts).
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    // Faster startup; we don't need GPU for headless DOM/CDP work.
    ...(opts.headless !== false ? ["--headless=new"] : []),
    "--remote-debugging-address=127.0.0.1",
    "about:blank",
  ];
}

/**
 * Spawn Chromium and wait until its CDP endpoint is reachable.
 */
export async function launchChrome(opts: LaunchChromeOptions): Promise<ChromeInstance> {
  const binaryPath = opts.binaryPath ?? automationChromeBinary();
  if (!binaryPath) {
    throw new ChromeNotFoundError(chromeBinaryProbes());
  }

  fs.mkdirSync(opts.userDataDir, { recursive: true });
  const args = [...defaultArgs(opts), ...(opts.extraArgs ?? [])];

  // A missing/invalid binary surfaces differently across runtimes: Node emits
  // an async 'error' event on the child; Bun may throw synchronously OR emit
  // 'error'. Capture all three into one ChromeLaunchError.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(binaryPath, args, {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
  } catch (err) {
    throw new ChromeLaunchError(
      `failed to spawn Chromium at '${binaryPath}': ${(err as Error).message}`,
    );
  }

  // Latch the first spawn 'error' (e.g., ENOENT) so the readiness loop can
  // fail fast instead of letting it become an unhandled exception.
  let spawnError: Error | null = null;
  child.on("error", (err) => {
    spawnError = err;
  });

  // Detach from parent so it survives daemon restart. We track its pid.
  child.unref();

  if (!child.pid) {
    throw new ChromeLaunchError("Chromium spawn returned no pid");
  }
  const pid = child.pid;

  const readyTimeoutMs = (opts.readyTimeoutSec ?? 20) * 1000;
  const deadline = Date.now() + readyTimeoutMs;
  // CDP port goes from free → bound when Chrome is ready.
  // We poll isPortFree until it returns false (i.e., Chrome is listening).
  while (Date.now() < deadline) {
    // A spawn 'error' (e.g., bad binary path) latched asynchronously → fail fast.
    if (spawnError) {
      throw new ChromeLaunchError(
        `failed to spawn Chromium at '${binaryPath}': ${(spawnError as Error).message}`,
        pid,
      );
    }
    // If the child crashed early, fail fast.
    if (!isPidAlive(pid)) {
      throw new ChromeLaunchError(
        `Chromium exited before CDP became ready (pid ${pid})`,
        pid,
      );
    }
    if (!(await isPortFree(opts.cdpPort))) {
      return {
        pid,
        cdpPort: opts.cdpPort,
        userDataDir: opts.userDataDir,
        headless: opts.headless !== false,
        binaryPath,
      };
    }
    await sleep(150);
  }
  // Timed out — kill the orphan before throwing.
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  throw new ChromeLaunchError(
    `Chromium CDP port ${opts.cdpPort} did not become listening within ${opts.readyTimeoutSec ?? 20}s`,
    pid,
  );
}

/** Politely stop a Chrome instance: SIGTERM, then SIGKILL after timeout. */
export async function stopChrome(
  pid: number,
  opts: { timeoutMs?: number; killTimeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const killTimeoutMs = opts.killTimeoutMs ?? 3000;
  const stages = [["SIGTERM", timeoutMs], ["SIGKILL", killTimeoutMs]] as const;
  for (const [signal, waitMs] of stages) {
    if (!isPidAlive(pid)) return;
    try {
      process.kill(pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      throw err;
    }

    const deadline = performance.now() + waitMs;
    while (performance.now() < deadline) {
      if (!isPidAlive(pid)) return;
      await sleep(Math.min(100, Math.max(0, deadline - performance.now())));
    }
  }
  if (isPidAlive(pid)) throw new ChromeStopError(pid, killTimeoutMs);
}

/** Returns true if a process with `pid` is alive. Cheap; uses signal 0.
 *  Stricter than pidAlive.ts on purpose: a probe that fails for a reason other
 *  than "gone" or "not yours" is thrown, because stopChrome must not read a
 *  failed probe as an exit, and lockFile.ts must not read one as a dead holder. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM" || code === "EACCES") return true;
    throw err;
  }
}
