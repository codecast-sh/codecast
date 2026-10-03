// One headless Chrome per identity. A profile directory is what isolates
// localStorage, so two of them are two signed in people; `--headless=new`
// reports `visibilityState: "visible"`, which the presence reporter and the
// walkie door both require, and `--mute-audio` keeps every rig silent. Fake
// media stands in for the microphone and camera without a prompt.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { connect, sleep } from "./cdp.mjs";
import { signIn } from "./auth.mjs";

export const CHROME = process.env.RIG_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function chromeArgs({ port, profile, extra = [] }) {
  return [
    "--headless=new",
    "--mute-audio",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=AudioServiceSandbox",
    "--window-size=1280,860",
    ...extra,
    "about:blank",
  ];
}

/** Launch, wait for the DevTools port, hand back the process. */
export async function launchChrome({ port, profile, fresh = false, log, extra = [] }) {
  if (fresh && existsSync(profile)) rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const child = spawn(CHROME, chromeArgs({ port, profile, extra }), { stdio: ["ignore", "ignore", log ? "pipe" : "ignore"] });
  if (log && child.stderr) child.stderr.on("data", (d) => log(String(d)));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return child;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  child.kill("SIGKILL");
  throw new Error(`chrome on ${port} never answered`);
}

/** One person in their own browser: Chrome up, its page connected with
 *  focus emulated (a headless page is never focused otherwise), signed in as
 *  `userId` on `dep` and landed on `path`. `prepare(page)` runs before the
 *  sign in, for init scripts and emulation the app must boot under. */
export async function launchSignedIn({ port, profile, fresh = true, dep, userId, path, extra = [], prepare }) {
  const child = await launchChrome({ port, profile, fresh, extra });
  const page = await connect(port, /about:blank|localhost/);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  if (prepare) await prepare(page);
  await signIn(page, dep, userId, path);
  return { child, page };
}

/** SIGKILL: the page gets no unload, no leave, no last heartbeat. That is
 *  what a dead seat is. */
export function killChrome(child, profile) {
  if (!child || child.exitCode !== null) return;
  if (child.pid) {
    child.kill("SIGKILL");
    return;
  }
  // An attached browser (run.mjs --attach) was not spawned here: by profile.
  if (profile) execSync(`pkill -9 -f -- "--user-data-dir=${profile}" || true`);
  child.exitCode = 137;
}
