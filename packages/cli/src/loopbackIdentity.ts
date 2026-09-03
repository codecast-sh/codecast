// The daemon's loopback identity: the port its HTTP server listens on and the
// token the web presents on that server's WebSocket.
//
// Both used to die with the process. The port came from listen(0) and the
// token from a fresh randomBytes per boot, so every restart invalidated every
// browser tab's cached endpoint: the tab had to rediscover the daemon through
// a relay round trip that cannot complete until the command subscription is
// up, at the very end of boot. Persisting both means a restart is invisible to
// an open terminal panel.
//
// The token sits at rest at mode 0600, the same trust boundary as the api
// token already in config.json. The decision is recorded on plan pl-497. A
// disk clone or Migration Assistant carries this file the way it carries
// .machine_key; the token only authenticates on that machine's loopback, and
// `cast daemon rotate-token` replaces it.
//
// This module imports nothing but node builtins on purpose: the CLI loads it
// for `rotate-token` and a future worker process loads it before the daemon
// exists, so it must not drag in ws or the daemon's module graph.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Server } from "node:http";

export interface LoopbackIdentity {
  port: number;
  token: string;
  created_at: number;
  /** The daemon that last listened on this port. Readers use it to tell a live
   *  identity from one an older daemon left behind. */
  pid?: number;
}

export function identityFile(configDir: string): string {
  return path.join(configDir, "loopback-identity.json");
}

export function hookPortFile(configDir: string): string {
  return path.join(configDir, "hook-port");
}

export function generateTerminalToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** The saved identity, or null when the file is missing, unparsable or has no
 *  token. A file written before created_at existed still loads: the token is
 *  the part that must survive a restart. */
export function readIdentity(configDir: string): LoopbackIdentity | null {
  let raw: string;
  try {
    raw = fs.readFileSync(identityFile(configDir), "utf-8");
  } catch {
    return null;
  }
  let parsed: { port?: unknown; token?: unknown; created_at?: unknown; pid?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed.token !== "string" || !parsed.token) return null;
  const port = typeof parsed.port === "number" && Number.isFinite(parsed.port) ? Math.floor(parsed.port) : 0;
  const createdAt =
    typeof parsed.created_at === "number" && Number.isFinite(parsed.created_at) ? parsed.created_at : Date.now();
  const id: LoopbackIdentity = { port: port > 0 ? port : 0, token: parsed.token, created_at: createdAt };
  if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) id.pid = parsed.pid;
  return id;
}

// writeFileSync applies `mode` only when it creates the file, so a rewrite of
// a file that already exists at 0644 would keep 0644. Chmod after every write.
function writePrivate(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function writeIdentity(configDir: string, id: LoopbackIdentity): void {
  writePrivate(identityFile(configDir), JSON.stringify(id));
}

export function writeHookPort(configDir: string, port: number): void {
  writePrivate(hookPortFile(configDir), String(port));
}

/** The saved identity, or a fresh one written to disk on first boot. */
export function loadOrCreateIdentity(configDir: string): LoopbackIdentity {
  const existing = readIdentity(configDir);
  if (existing) return existing;
  const minted: LoopbackIdentity = { port: 0, token: generateTerminalToken(), created_at: Date.now() };
  try {
    writeIdentity(configDir, minted);
  } catch {
    // An unwritable config dir still gets a working in-memory identity; the
    // daemon then behaves the way it did before the file existed.
  }
  return minted;
}

/** A new token on the same port. The caller restarts the daemon so the running
 *  process picks it up; every open panel reconnects on its next probe. */
export function rotateIdentityToken(configDir: string): LoopbackIdentity {
  const existing = readIdentity(configDir);
  const rotated: LoopbackIdentity = {
    port: existing?.port ?? 0,
    token: generateTerminalToken(),
    created_at: existing?.created_at ?? Date.now(),
    ...(existing?.pid !== undefined ? { pid: existing.pid } : {}),
  };
  writeIdentity(configDir, rotated);
  return rotated;
}

export interface ListenOptions {
  configDir: string;
  identity: LoopbackIdentity;
  log: (msg: string) => void;
}

/**
 * Listen on the saved port, falling back to an OS-assigned one when something
 * else holds it, and record the port that won in both hook-port and the
 * identity file.
 *
 * Only EADDRINUSE falls back, and only once: a second failure means the local
 * interface is unusable and looping would spin. The resolved promise is what
 * callers wait on rather than reading a port that is still 0.
 */
export function listenOnSavedPort(server: Server, opts: ListenOptions): Promise<number> {
  const { configDir, identity, log } = opts;
  return new Promise<number>((resolve) => {
    let fellBack = false;
    let listening = false;

    const onError = (err: NodeJS.ErrnoException): void => {
      if (listening) return;
      if (err.code === "EADDRINUSE" && !fellBack) {
        fellBack = true;
        log(`Hook server port ${identity.port} is taken, asking the OS for another`);
        server.listen(0, "127.0.0.1");
        return;
      }
      log(`Hook server listen failed: ${err.message}`);
    };

    server.on("error", onError);
    server.on("listening", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") return;
      listening = true;
      server.removeListener("error", onError);
      const port = addr.port;
      try {
        writeHookPort(configDir, port);
        writeIdentity(configDir, { ...identity, port, pid: process.pid });
      } catch (err) {
        log(`Hook server could not persist its identity: ${err instanceof Error ? err.message : String(err)}`);
      }
      // `cast bench daemon` measures boot blackout by matching this line
      // exactly (bench/logReport.ts LISTEN_RE, anchored at both ends). Any
      // suffix zeroes the measurement, so reuse detail goes on its own line.
      log(`Hook server listening on 127.0.0.1:${port}`);
      resolve(port);
    });

    server.listen(identity.port > 0 ? identity.port : 0, "127.0.0.1");
  });
}
