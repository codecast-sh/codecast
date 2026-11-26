import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEV_SESSION_PATH } from "../lib/devSessionPath";

/**
 * Dev servers sign themselves in (ct-101742). Every `cast dev` port is a fresh
 * origin with an empty localStorage, GitHub sign-in cannot return to
 * localhost, and a carried Chrome cookie brings no codecast session (it lives
 * in localStorage), so an agent checking its change used to stop and ask the
 * person to sign in.
 *
 * Serve only: answers POST /__cast/dev-session with a fresh session for the
 * user this machine's `cast` CLI is signed in as, minted with the admin key
 * through packages/convex/run.sh (verification:mintSession, recorded in the
 * access log like every staff run). lib/devSignIn installs it before the app
 * boots. A machine without the admin key gets a refusal and signs in by hand.
 *
 * The answer is a long-lived prod session, so it goes only to a same-origin
 * page on this machine: a loopback peer (`host: true` also listens on the
 * LAN), a Host this server serves (no DNS rebinding), and a browser request
 * from this origin (Sec-Fetch-Site; a cross-site page always sends it).
 */

type Minted = { token: string; refreshToken: string; user: { _id: string; email?: string } };
type Identity = { userId: string; convexUrl: string };

const PROD_CONVEX_URL = "https://convex.codecast.sh";
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Why this request may not have a session, or null when it may. */
export function refusal(
  req: { method?: string; headers: IncomingMessage["headers"]; peer?: string },
  servedHosts: readonly string[],
): string | null {
  if (req.method !== "POST") return "POST only";
  if (!req.peer || !LOOPBACK_PEERS.has(req.peer)) return "not from this machine";
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host) && !servedHosts.includes(host)) return `not a host this server serves: ${host || "none"}`;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return `a ${site} page may not take a session`;
  return null;
}

/** The deployment the web talks to, by lib/convexUrl's rule. */
export function webConvexUrl(raw: string | undefined): string {
  return typeof raw === "string" && /^https?:\/\/[^/\s]+/i.test(raw) ? raw : PROD_CONVEX_URL;
}

/** Who the local `cast` CLI is signed in as (~/.codecast/config.json). */
export function cliIdentity(configDir = process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast")): Identity | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf-8"));
    if (typeof cfg.user_id !== "string" || !cfg.user_id) return null;
    return { userId: cfg.user_id, convexUrl: cfg.convex_url || PROD_CONVEX_URL };
  } catch {
    return null;
  }
}

/**
 * The checkout whose run.sh holds the admin key for `convexUrl`: this one, or
 * the main checkout behind this worktree (its packages/convex/.env.local is
 * gitignored, so a fresh worktree has none).
 */
export function adminCheckout(repo: string, convexUrl: string, commonDir = gitCommonDir(repo)): string | null {
  const candidates = [repo, ...(commonDir ? [path.dirname(commonDir)] : [])];
  for (const root of candidates) {
    let env: string;
    try {
      env = fs.readFileSync(path.join(root, "packages", "convex", ".env.local"), "utf-8");
    } catch {
      continue;
    }
    const url = env.match(/^CONVEX_SELF_HOSTED_URL=(.*)$/m)?.[1]?.trim();
    if (url === convexUrl && /^CONVEX_SELF_HOSTED_ADMIN_KEY=./m.test(env) && fs.existsSync(path.join(root, "packages", "convex", "run.sh"))) return root;
  }
  return null;
}

function gitCommonDir(repo: string): string | null {
  try {
    const out = fs.readFileSync(path.join(repo, ".git"), "utf-8");
    // A worktree's .git is a file: "gitdir: <main>/.git/worktrees/<name>".
    const gitdir = out.match(/^gitdir: (.*)$/m)?.[1]?.trim();
    return gitdir ? path.resolve(gitdir, "..", "..") : null;
  } catch {
    return null;
  }
}

function mintWithRunSh(root: string, userId: string): Promise<Minted> {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      [path.join(root, "packages", "convex", "run.sh"), "verification:mintSession", JSON.stringify({ user_id: userId })],
      { cwd: root, timeout: 90_000, encoding: "utf-8" },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || stdout || err.message).trim().split("\n").slice(-3).join(" | ")));
        try {
          const minted = JSON.parse(stdout.slice(stdout.indexOf("{"))) as Minted;
          if (!minted.token || !minted.refreshToken) throw new Error("no tokens");
          resolve(minted);
        } catch {
          reject(new Error(`could not read the minted session: ${stdout.slice(0, 200)}`));
        }
      },
    );
  });
}

export type DevSignInDeps = {
  identity: () => Identity | null;
  checkout: (convexUrl: string) => string | null;
  mint: (root: string, userId: string) => Promise<Minted>;
};

/** The endpoint, apart from Vite so a test can drive it. */
export function devSessionHandler(webUrl: () => string, servedHosts: () => readonly string[], deps: DevSignInDeps) {
  // Tabs that boot together share one mint rather than each starting a run.sh.
  let inflight: Promise<Minted> | null = null;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: object) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify(body));
    };
    const why = refusal({ method: req.method, headers: req.headers, peer: req.socket.remoteAddress }, servedHosts());
    if (why) return send(403, { error: why });
    const me = deps.identity();
    if (!me) return send(503, { error: "cast is not signed in on this machine (cast auth)" });
    const url = webUrl();
    if (me.convexUrl !== url) return send(503, { error: `this dev server talks to ${url}, but cast is signed in to ${me.convexUrl}` });
    const root = deps.checkout(url);
    if (!root) return send(503, { error: `no admin key for ${url} on this machine (packages/convex/.env.local)` });
    try {
      inflight ??= deps.mint(root, me.userId).finally(() => (inflight = null));
      const minted = await inflight;
      send(200, { token: minted.token, refreshToken: minted.refreshToken, user: minted.user._id });
    } catch (e) {
      send(503, { error: `minting failed: ${(e as Error).message}` });
    }
  };
}

export function devSignInPlugin(): Plugin {
  const repo = path.resolve(__dirname, "..", "..", "..");
  let convexUrl = PROD_CONVEX_URL;
  let hosts: readonly string[] = [];
  return {
    name: "codecast-dev-sign-in",
    apply: "serve",
    configResolved(config) {
      convexUrl = webConvexUrl(config.env.VITE_CONVEX_URL);
      const allowed = config.server.allowedHosts;
      hosts = Array.isArray(allowed) ? allowed.map((h) => h.toLowerCase()) : [];
    },
    configureServer(server) {
      const handle = devSessionHandler(() => convexUrl, () => hosts, {
        identity: () => cliIdentity(),
        checkout: (url) => adminCheckout(repo, url),
        mint: mintWithRunSh,
      });
      server.middlewares.use(DEV_SESSION_PATH, (req, res) => void handle(req, res));
    },
  };
}
