/**
 * `cast remote` CLI subcommand wiring.
 *
 * Move a Claude Code session between this machine and a remote Mac:
 *   cast remote hosts                 list configured remote hosts
 *   cast remote push <session>        push a session to the remote Mac
 *   cast remote pull <session>        pull the latest remote state back
 *   cast remote run  <session> <msg>  drive the moved session on the remote
 *
 * Registered via registerRemoteCommand(program) from index.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Command } from "commander";
import {
  pushSession,
  pullSession,
  remotePrompt,
  resolveLocalSession,
  type MoveResult,
  type RemoteHost,
} from "./session-move.js";
import { deviceInfo } from "./device.js";

const SCALEWAY_DIR = path.join(os.homedir(), ".codecast", "scaleway");
const HOSTS_FILE = path.join(SCALEWAY_DIR, "hosts.json");
// Where the active move's placement is remembered so `pull` can find it
// without re-deriving (kept tiny + local).
const MOVES_FILE = path.join(os.homedir(), ".codecast", "remote-moves.json");

interface ScalewayHostMeta {
  id: string;
  address: string;
  sshUsername: string;
  zone: string;
  commercialType: string;
  stopped?: boolean;
}

/** Load a usable remote Mac host from the Scaleway registry. */
function loadRemoteHost(hostId?: string): RemoteHost {
  if (!fs.existsSync(HOSTS_FILE)) {
    throw new Error(
      `No remote hosts registered. Provision a Mac (cast remote provision — TODO) or add ${HOSTS_FILE}.`,
    );
  }
  const { hosts } = JSON.parse(fs.readFileSync(HOSTS_FILE, "utf-8")) as { hosts: ScalewayHostMeta[] };
  const host = hostId
    ? hosts.find((h) => h.id === hostId)
    : hosts.find((h) => !h.stopped) ?? hosts[0];
  if (!host) throw new Error(`No usable remote host found in ${HOSTS_FILE}`);

  // Per-host key (written at provision) or the shared d7 test key as fallback.
  const perHost = path.join(SCALEWAY_DIR, host.id, "id_ed25519");
  const fallback = path.join(SCALEWAY_DIR, "d7_id_ed25519");
  const keyPath = fs.existsSync(perHost) ? perHost : fallback;

  return {
    address: host.address,
    user: host.sshUsername || "m1",
    keyPath,
    remoteBaseDir: `/Users/${host.sshUsername || "m1"}/work`,
  };
}

function readMoves(): Record<string, MoveResult> {
  if (!fs.existsSync(MOVES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(MOVES_FILE, "utf-8")); } catch { return {}; }
}
function writeMoves(m: Record<string, MoveResult>): void {
  fs.mkdirSync(path.dirname(MOVES_FILE), { recursive: true });
  fs.writeFileSync(MOVES_FILE, JSON.stringify(m, null, 2));
}

function parseJson(out: string): { result?: string; session_id?: string } {
  try { return JSON.parse(out); } catch { return { result: out.slice(0, 200) }; }
}

export function registerRemoteCommand(program: Command): void {
  const remote = program
    .command("remote")
    .description("Move a Claude Code session to/from a remote Mac");

  remote
    .command("hosts")
    .description("List configured remote hosts and this device's id")
    .action(() => {
      const d = deviceInfo();
      console.log(`this device: ${d.label}  (${d.deviceId})`);
      if (!fs.existsSync(HOSTS_FILE)) { console.log("no remote hosts registered"); return; }
      const { hosts } = JSON.parse(fs.readFileSync(HOSTS_FILE, "utf-8")) as { hosts: ScalewayHostMeta[] };
      for (const h of hosts) {
        console.log(`  ${h.id}  ${h.sshUsername}@${h.address}  ${h.commercialType} ${h.stopped ? "(stopped)" : ""}`);
      }
    });

  remote
    .command("push <sessionId>")
    .description("Push a session (worktree + transcript + credential) to the remote Mac")
    .option("--host <id>", "Target a specific host id")
    .action((sessionId: string, opts: { host?: string }) => {
      const host = loadRemoteHost(opts.host);
      const s = resolveLocalSession(sessionId);
      console.log(`pushing ${sessionId}\n  ${s.cwd}\n  -> ${host.user}@${host.address}`);
      const move = pushSession(sessionId, host);
      const moves = readMoves();
      moves[sessionId] = move;
      writeMoves(moves);
      console.log(`ready on remote: ${move.remoteCwd}`);
      console.log(`  resume there: ssh ${host.user}@${host.address} 'cd ${move.remoteCwd} && claude --resume ${sessionId}'`);
      console.log(`  or drive it:  cast remote run ${sessionId} "<message>"`);
    });

  remote
    .command("pull <sessionId>")
    .description("Pull the latest remote state (transcript + working tree) back to local")
    .option("--host <id>", "Target a specific host id")
    .action((sessionId: string, opts: { host?: string }) => {
      const host = loadRemoteHost(opts.host);
      const moves = readMoves();
      const move = moves[sessionId];
      if (!move) {
        console.error(`No recorded push for ${sessionId}. Was it pushed from this machine?`);
        process.exit(1);
      }
      console.log(`pulling ${sessionId} back from ${host.user}@${host.address}`);
      const r = pullSession(sessionId, host, move);
      if (!r.ff) {
        console.error(`CONFLICT: ${r.reason}`);
        process.exit(2);
      }
      console.log(`pulled to ${move.localCwd}`);
    });

  remote
    .command("run <sessionId> <prompt>")
    .description("Drive the moved session on the remote (one-shot, print mode)")
    .option("--host <id>", "Target a specific host id")
    .option("--mode <mode>", "permission mode: acceptEdits|bypassPermissions|default", "acceptEdits")
    .action((sessionId: string, prompt: string, opts: { host?: string; mode?: string }) => {
      const host = loadRemoteHost(opts.host);
      const moves = readMoves();
      const move = moves[sessionId];
      if (!move) { console.error(`No recorded push for ${sessionId}.`); process.exit(1); }
      const out = remotePrompt(host, move.remoteCwd, sessionId, prompt, {
        permissionMode: (opts.mode as "acceptEdits" | "bypassPermissions" | "default") ?? "acceptEdits",
      });
      console.log(parseJson(out).result ?? out);
    });
}
