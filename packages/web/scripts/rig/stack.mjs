#!/usr/bin/env bun
// The dev stack a rig runs against, and the one place that decides which
// Convex deployment a rig may talk to.
//
//   bun scripts/rig/stack.mjs up [--refresh]   # start what is missing, idempotent
//   bun scripts/rig/stack.mjs status
//   bun scripts/rig/stack.mjs down
//
// The stack is two processes in tmux:
//
// - `smoke-deploy`: a disposable local Convex deployment, the recipe in
//   docs/architecture/sync-sim.md ("Disposable Convex deployment") run by
//   script: a scratch copy of the tree with no .env.local in it, `convex dev`
//   as an anonymous local deployment on 127.0.0.1, with the production
//   variables unset. Its database lives in
//   ~/.convex/anonymous-convex-backend-state/anonymous-agent/, so the seeded
//   world survives restarts. `--refresh` copies the tree over the scratch
//   copy again and the watcher pushes the change. Two backend caps are
//   raised (the CLI passes its environment to the backend it spawns): a
//   function's JS time from 1s to 30s (DATABASE_UDF_USER_TIMEOUT_SECONDS) and
//   a push's module analysis from 4s to 120s
//   (ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS). On this loaded machine a cold
//   function misses 1s and a push misses 4s, and the smoke checks what the
//   pages show, not how fast the backend is.
// - `smoke-web`: a second vite on the main checkout (port 3297) with
//   VITE_CONVEX_URL pointed at that deployment, its own optimizer cache (the
//   dev server on 3200 keeps node_modules/.vite) and no HMR, so another
//   session's save never reloads a page mid leg.
//
// Two deployments exist for a rig. `localDeployment()` is the default and the
// only one the smoke suite accepts. `prodDeployment()` is the self hosted prod
// at convex.codecast.sh, which the face row rig needs for calls (LiveKit), and
// it answers only when RIG_DEPLOYMENT=prod is set: no rig reaches prod by
// default.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { sleep } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, "../../../..");
export const WEB_DIR = resolve(HERE, "../..");
export const SCRATCH = process.env.RIG_SCRATCH || "/tmp/codecast-smoke-deploy";
export const WEB_PORT = Number(process.env.RIG_WEB_PORT || 3297);
const TMUX_CONVEX = "smoke-deploy";
const TMUX_WEB = "smoke-web";
const ANON_STATE = join(homedir(), ".convex/anonymous-convex-backend-state");
export const PROD_CONVEX_URL = "https://convex.codecast.sh";

const envValue = (text, key) => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? null;

/** The local anonymous deployment the scratch copy runs, or a reason it is not there. */
export function localDeployment() {
  const envFile = join(SCRATCH, "packages/convex/.env.local");
  if (!existsSync(envFile)) throw new Error(`no local deployment: ${envFile} is missing (run: bun scripts/rig/stack.mjs up)`);
  const env = readFileSync(envFile, "utf8");
  const convexUrl = envValue(env, "CONVEX_URL");
  const deployment = envValue(env, "CONVEX_DEPLOYMENT");
  // The guard the recipe's step 4 states: a loopback URL and an anonymous
  // deployment, or nothing goes out.
  if (!convexUrl || new URL(convexUrl).hostname !== "127.0.0.1" || !deployment?.startsWith("anonymous:")) {
    throw new Error(`refusing: ${envFile} names ${convexUrl} ${deployment}, not a local anonymous deployment`);
  }
  const name = deployment.slice("anonymous:".length);
  const config = JSON.parse(readFileSync(join(ANON_STATE, name, "config.json"), "utf8"));
  const siteUrl = `http://127.0.0.1:${config.ports?.site ?? Number(new URL(convexUrl).port) + 1}`;
  return { kind: "local", name, convexUrl, siteUrl, adminKey: config.adminKey, appUrl: `http://localhost:${WEB_PORT}` };
}

/** The self hosted prod, only when the caller's environment asks for it by name. */
export function prodDeployment(why) {
  if (process.env.RIG_DEPLOYMENT !== "prod") {
    throw new Error(`${why} runs against prod (convex.codecast.sh), which no rig reaches by default. Set RIG_DEPLOYMENT=prod to run it there on purpose.`);
  }
  const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (!adminKey) throw new Error("RIG_DEPLOYMENT=prod needs CONVEX_SELF_HOSTED_ADMIN_KEY in the environment");
  return { kind: "prod", name: "prod", convexUrl: PROD_CONVEX_URL, siteUrl: PROD_CONVEX_URL, adminKey, appUrl: process.env.RIG_APP_URL || "http://localhost:3200" };
}

/** An admin client on a deployment, acting as a user when `userId` is given
 *  (the identity Convex Auth issues: subject `<user id>|session`). Admin auth
 *  also reaches internal functions, as `convex run` does. */
export function adminClient(dep, userId) {
  // logger off: the backend's console lines (auth:store's INFO) are not the rig's output.
  const client = new ConvexHttpClient(dep.convexUrl, { logger: false });
  client.setAdminAuth(dep.adminKey, userId ? { subject: `${userId}|session`, issuer: dep.siteUrl } : undefined);
  return client;
}

// ── processes ──

const tmuxHas = (name) => {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const listening = (port) => {
  try {
    return execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: "utf8" }).trim().length > 0;
  } catch {
    return false;
  }
};
const until = async (what, fn, timeoutMs, everyMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`${what} not ready after ${Math.round(timeoutMs / 1000)}s${last ? `: ${last.message}` : ""}`);
};

/** The recipe's steps 1 and 2: a copy of the tracked and untracked but not
 *  ignored files, dependencies linked, and a refusal if anything could point
 *  the CLI at a real deployment. */
function copyTree() {
  execSync(`mkdir -p "${SCRATCH}" && git ls-files -co --exclude-standard -z | perl -0ne 'chomp; print "$_\\0" if -f' | tar -c --null -T - -f - | tar -x -C "${SCRATCH}"`, { cwd: REPO, stdio: "inherit", shell: "/bin/bash" });
  for (const d of ["node_modules", ...execSync("ls -d packages/*/node_modules", { cwd: REPO, encoding: "utf8" }).trim().split("\n")]) {
    if (!existsSync(join(SCRATCH, d))) execFileSync("ln", ["-s", join(REPO, d), join(SCRATCH, d)]);
  }
  const travelled = execSync(`find "${SCRATCH}" -name .env.local -not -path '*/node_modules/*' -not -path '${SCRATCH}/packages/convex/.env.local'`, { encoding: "utf8" }).trim();
  if (travelled) throw new Error(`refusing: an .env.local travelled into the scratch copy:\n${travelled}`);
  writeFileSync(join(SCRATCH, "sim.env"), "CONVEX_DEPLOYMENT=anonymous:anonymous-agent\n");
}

/** Convex Auth signs its sessions with JWT_PRIVATE_KEY and serves JWKS; a
 *  fresh deployment has neither, so one pair is minted once. */
async function ensureAuthKeys(dep) {
  const admin = adminClient(dep);
  const get = (name) => admin.query("_system/cli/queryEnvironmentVariables:get", { name });
  if ((await get("JWKS")) && (await get("JWT_PRIVATE_KEY"))) return false;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trimEnd().replace(/\n/g, " ");
  const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey.export({ format: "jwk" }) }] });
  const r = await fetch(`${dep.convexUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: { Authorization: `Convex ${dep.adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ changes: [{ name: "JWT_PRIVATE_KEY", value: pem }, { name: "JWKS", value: jwks }, { name: "SITE_URL", value: dep.appUrl }] }),
  });
  if (!r.ok) throw new Error(`setting the auth keys failed: ${r.status} ${await r.text()}`);
  return true;
}

/** Start whatever is missing and wait until the deployment answers with the
 *  tree's functions and the app answers its root. */
export async function stackUp({ refresh = false, log = console.log } = {}) {
  // A push this call waits for: the tree was copied, or the process started.
  // The functions of an earlier push keep answering meanwhile, so the wait
  // reads the watcher's own "✔ HH:MM:SS Convex functions ready!" line.
  const since = new Date().toTimeString().slice(0, 8);
  let pushing = false;
  if (refresh || !existsSync(join(SCRATCH, "packages/convex/package.json"))) {
    log(`copying the tree to ${SCRATCH}`);
    copyTree();
    pushing = true;
  }
  for (const v of ["CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY", "CONVEX_DEPLOY_KEY"]) {
    if (process.env[v]) log(`(${v} is set here; the deployment process starts without it)`);
  }
  if (!tmuxHas(TMUX_CONVEX)) {
    log("starting the local deployment (tmux smoke-deploy); the first push takes minutes");
    execFileSync("tmux", ["new", "-d", "-s", TMUX_CONVEX, "-c", join(SCRATCH, "packages/convex")]);
    pushing = true;
    execFileSync("tmux", ["send-keys", "-t", TMUX_CONVEX, "env -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY -u CONVEX_DEPLOYMENT -u CONVEX_DEPLOY_KEY CONVEX_AGENT_MODE=anonymous DATABASE_UDF_USER_TIMEOUT_SECONDS=30 ISOLATE_ANALYZE_USER_TIMEOUT_SECONDS=120 npx convex dev --env-file ../../sim.env --codegen disable --typecheck disable --tail-logs disable", "Enter"]);
  }
  const dep = await until("the local deployment's .env.local", () => {
    try {
      return localDeployment();
    } catch (e) {
      if (/refusing/.test(e.message)) throw e;
      return null;
    }
  }, 600_000);
  // A query the tree defines: answers null signed out, and "Could not find
  // public function" until the first push lands.
  if (pushing) {
    await until("the local deployment's push", () => {
      const pane = execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", TMUX_CONVEX, "-S", "-5000"], { encoding: "utf8" });
      const ready = [...pane.matchAll(/(\d\d:\d\d:\d\d) Convex functions ready!/g)].map((m) => m[1]);
      return ready.some((t) => t >= since);
    }, 1_200_000, 5000);
  }
  await until("the local deployment's functions", async () => (await adminClient(dep).query("users:getCurrentUser", {})) === null, 900_000, 5000);
  if (await ensureAuthKeys(dep)) log("set JWT_PRIVATE_KEY, JWKS and SITE_URL on the local deployment");
  if (!listening(WEB_PORT)) {
    if (tmuxHas(TMUX_WEB)) execFileSync("tmux", ["kill-session", "-t", TMUX_WEB]);
    log(`starting vite on ${WEB_PORT} against ${dep.convexUrl} (tmux smoke-web)`);
    execFileSync("tmux", ["new", "-d", "-s", TMUX_WEB, "-c", WEB_DIR]);
    execFileSync("tmux", ["send-keys", "-t", TMUX_WEB, `VITE_CONVEX_URL=${dep.convexUrl} node_modules/.bin/vite --config scripts/rig/vite.smoke.config.mjs --port ${WEB_PORT} --strictPort`, "Enter"]);
  }
  await until(`the app on ${WEB_PORT}`, async () => (await fetch(`${dep.appUrl}/`, { signal: AbortSignal.timeout(30_000) })).ok, 600_000);
  return dep;
}

export function stackStatus() {
  const lines = [];
  try {
    const dep = localDeployment();
    lines.push(`deployment ${dep.name} at ${dep.convexUrl} (${listening(Number(new URL(dep.convexUrl).port)) ? "listening" : "down"})`);
  } catch (e) {
    lines.push(`deployment: ${e.message}`);
  }
  if (existsSync(SCRATCH)) lines.push(`scratch copy ${SCRATCH}, copied ${Math.round((Date.now() - statSync(join(SCRATCH, "sim.env")).mtimeMs) / 60_000)} min ago`);
  lines.push(`app http://localhost:${WEB_PORT} (${listening(WEB_PORT) ? "listening" : "down"})`);
  return lines.join("\n");
}

export function stackDown() {
  for (const s of [TMUX_WEB, TMUX_CONVEX]) {
    if (!tmuxHas(s)) continue;
    // Ctrl-C lets `convex dev` stop the local backend it started.
    execFileSync("tmux", ["send-keys", "-t", s, "C-c"]);
    execSync("sleep 3");
    execFileSync("tmux", ["kill-session", "-t", s]);
  }
}

if (import.meta.main) {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  if (cmd === "up") {
    const dep = await stackUp({ refresh: rest.includes("--refresh") });
    console.log(`up: ${dep.convexUrl}, app ${dep.appUrl}`);
  } else if (cmd === "down") {
    stackDown();
    console.log("down");
  } else {
    console.log(stackStatus());
  }
}
