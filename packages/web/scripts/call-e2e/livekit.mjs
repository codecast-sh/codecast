// The LiveKit plumbing every script in this folder shares: credentials, token
// minting and the server API.
//
// Credentials come from the environment when LIVEKIT_URL, LIVEKIT_API_KEY and
// LIVEKIT_API_SECRET are all set, and otherwise from the Convex prod env,
// which is where the real call path reads them. Reading that env costs an npx
// round trip of tens of seconds on a loaded machine, so the three values are
// cached in a 0600 file inside a 0700 directory under the per-user temp dir,
// and nothing here ever prints them. `--refresh-env` on any script re-reads.
//
// Tokens are signed by the same signLivekitJwt the Convex control plane uses
// (packages/convex/convex/lib/livekitJwt.ts), imported straight from its .ts
// source through Node's type stripping, so the grant shape a synthetic
// participant carries cannot drift from a real member's.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// @livekit/rtc-node logs at debug level unless NODE_ENV is production, which
// interleaves raw JSON with these scripts' own lines. Every script imports
// this module before rtc-node, so setting it here quiets the SDK's logger.
process.env.NODE_ENV ||= "production";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONVEX_DIR = resolve(HERE, "../../../convex");
const KEYS = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];
export const ENV_CACHE = join(tmpdir(), "codecast-call-e2e", "livekit.env");

function parseEnvLines(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && KEYS.includes(m[1])) out[m[1]] = m[2];
  }
  return out;
}

const complete = (env) => KEYS.every((k) => env[k]);

export function loadLivekitEnv({ refresh = false } = {}) {
  if (complete(process.env)) return Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  if (!refresh && existsSync(ENV_CACHE)) {
    const cached = parseEnvLines(readFileSync(ENV_CACHE, "utf8"));
    if (complete(cached)) return cached;
  }
  process.stderr.write("Reading LIVEKIT_* from the Convex prod env (cached afterwards)...\n");
  // CONVEX_DEPLOYMENT is unset because the repo-root .env.local points it at
  // an anonymous local deployment, which would answer with an empty env.
  const env = { ...process.env };
  delete env.CONVEX_DEPLOYMENT;
  let text;
  try {
    text = execFileSync("npx", ["convex", "env", "list"], {
      cwd: CONVEX_DIR,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180_000,
    });
  } catch (err) {
    throw new Error(
      `Could not read the Convex env from ${CONVEX_DIR} (${String(err.stderr || err.message).trim().split("\n").pop()}). ` +
        "Export LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET instead.",
    );
  }
  const found = parseEnvLines(text);
  if (!complete(found)) {
    throw new Error(`The Convex env lacks ${KEYS.filter((k) => !found[k]).join(", ")}; calling is not configured there.`);
  }
  mkdirSync(dirname(ENV_CACHE), { recursive: true, mode: 0o700 });
  chmodSync(dirname(ENV_CACHE), 0o700);
  writeFileSync(ENV_CACHE, KEYS.map((k) => `${k}=${found[k]}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(ENV_CACHE, 0o600);
  return found;
}

let signer;
async function sign(opts) {
  if (!signer) {
    // Node warns on this import that packages/convex declares no module
    // type; it says nothing useful here, so it is dropped for this one load.
    // Warnings are emitted on a later tick, hence the wait before restoring.
    const listeners = process.listeners("warning");
    process.removeAllListeners("warning");
    try {
      ({ signLivekitJwt: signer } = await import(join(CONVEX_DIR, "convex/lib/livekitJwt.ts")));
      await new Promise((r) => setImmediate(r));
    } finally {
      for (const l of listeners) process.on("warning", l);
    }
  }
  return signer(opts);
}

// A participant's join token. `grant` defaults to signLivekitJwt's own
// participant grant, the one mintAccessToken hands a real member.
export function participantToken(env, { room, identity, name, metadata, ttlSeconds = 6 * 3600, grant }) {
  return sign({
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    identity,
    name,
    room,
    metadata,
    ttlSeconds,
    grant,
  });
}

export const httpBase = (env) => env.LIVEKIT_URL.replace(/^ws/, "http").replace(/\/+$/, "");

// One LiveKit server API call. The API is Twirp: a JSON POST per method, with
// a short lived admin token carrying only the grant that method checks.
export async function twirp(env, service, method, body, grant, room = "") {
  const token = await sign({
    apiKey: env.LIVEKIT_API_KEY,
    apiSecret: env.LIVEKIT_API_SECRET,
    identity: "call-e2e-admin",
    name: "call-e2e admin",
    room,
    ttlSeconds: 120,
    grant,
  });
  const res = await fetch(`${httpBase(env)}/twirp/livekit.${service}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${service}.${method} answered ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// The flag parser the scripts share: `--name value`, `--flag`, and positionals.
export function parseArgs(argv, { booleans = [] } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = a.slice(2, eq > 0 ? eq : undefined);
    if (eq > 0) flags[key] = a.slice(eq + 1);
    else if (booleans.includes(key)) flags[key] = true;
    else if (i + 1 < argv.length) flags[key] = argv[++i];
    else throw new Error(`--${key} needs a value`);
  }
  return { flags, positionals };
}

export function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
