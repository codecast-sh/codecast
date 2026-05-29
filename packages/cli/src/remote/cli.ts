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
  ensureRemoteClaudeReady,
  refreshRemoteCredential,
  loadRemoteHost,
  performMoveToRemote,
  type MoveResult,
  type RemoteHost,
} from "./session-move.js";
import { deviceInfo, deviceId } from "./device.js";
import { decryptToken } from "../tokenEncryption.js";

/** A Convex client + api_token + generated api, from the local config (move flow). */
async function convexClient(): Promise<{ client: any; token: string; api: any }> {
  const cfgPath = path.join(os.homedir(), ".codecast", "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  const token = cfg.auth_token?.startsWith("enc:") ? decryptToken(cfg.auth_token) : cfg.auth_token;
  const { ConvexHttpClient } = await import("convex/browser");
  const apiMod: any = await import("../../../convex/convex/_generated/api.js" as any);
  return { client: new ConvexHttpClient(cfg.convex_url), token, api: apiMod.api };
}

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

  // cast remote teardown — wipe credentials + stop daemon on a Mac
  remote
    .command("teardown")
    .description("Wipe credentials and stop the daemon on the remote Mac")
    .option("--host <id>", "Target a specific host id")
    .option("--destroy", "Also request Scaleway host deletion (if past 24h commitment)")
    .action(async (_opts: { host?: string; destroy?: boolean }) => {
      const host = loadRemoteHost(_opts.host);
      const SSH = `ssh -i ${host.keyPath} -o StrictHostKeyChecking=accept-new ${host.user}@${host.address}`;
      console.log(`tearing down ${host.user}@${host.address}`);
      const { execSync } = await import("node:child_process");
      execSync(`${SSH} 'rm -f ~/.claude/.credentials.json ~/.codecast/config.json; pkill -f "index.ts _daemon" 2>/dev/null; echo "credentials wiped, daemon stopped"'`, { stdio: "inherit" });
      if (_opts.destroy) {
        console.log("host destroy: not yet implemented (use Scaleway console or API)");
      }
    });

  // cast remote move <session> — atomic live handoff local -> Mac
  remote
    .command("move <sessionId>")
    .description("Move a live session to the remote Mac (handoff: transfer + flip owner + resume there)")
    .option("--host <id>", "Target a specific host id")
    .action(async (sessionId: string, opts: { host?: string }) => {
      const host = loadRemoteHost(opts.host);
      const { client, token, api } = await convexClient();
      const conv = await client.query(api.devices.resolveConversationBySession, { api_token: token, session_id: sessionId });
      if (!conv?._id) { console.error(`No conversation for session ${sessionId} (is it synced?)`); process.exit(1); }

      // identify the target Mac's codecast device id
      const devices = await client.query(api.devices.listDevices, { api_token: token });
      const macDevice = devices.find((d: any) => d.is_remote && d.online) ?? devices.find((d: any) => d.is_remote);
      if (!macDevice) { console.error("No online remote device found (start the Mac daemon)"); process.exit(1); }

      console.log(`moving ${sessionId} -> ${host.user}@${host.address} (device ${macDevice.device_id.slice(0, 8)})`);
      console.log("  [1/4] transfer worktree + transcript + credential");
      const move = pushSession(sessionId, host);
      console.log("  [2/4] prepare remote claude (onboarding + folder trust)");
      ensureRemoteClaudeReady(host, move.remoteCwd);
      refreshRemoteCredential(host);
      console.log("  [3/4] flip ownership + resume on the Mac");
      const r = await client.mutation(api.devices.moveSessionToDevice, {
        api_token: token, conversation_id: conv._id, owner_device_id: macDevice.device_id,
        project_path: move.remoteCwd, resume: true,
      });
      const moves = readMoves(); moves[sessionId] = move; writeMoves(moves);
      console.log("  [4/4] done — session now runs on the Mac");
      console.log(`  watch: ssh ${host.user}@${host.address} 'tmux attach -t cc-resume-${sessionId.slice(0, 8)}'`);
      console.log(`  command_id=${r.command_id}`);
    });

  // cast remote back <session> — migrate Mac -> local
  remote
    .command("back <sessionId>")
    .description("Bring a session back from the Mac to this machine")
    .option("--host <id>", "Target a specific host id")
    .action(async (sessionId: string, opts: { host?: string }) => {
      const host = loadRemoteHost(opts.host);
      const moves = readMoves();
      const move = moves[sessionId];
      if (!move) { console.error(`No recorded move for ${sessionId}.`); process.exit(1); }
      const { client, token, api } = await convexClient();
      const conv = await client.query(api.devices.resolveConversationBySession, { api_token: token, session_id: sessionId });
      if (!conv?._id) { console.error(`No conversation for ${sessionId}`); process.exit(1); }

      console.log(`bringing ${sessionId} back to local (${move.localCwd})`);
      console.log("  [1/2] pull transcript + working tree (git ff)");
      const pr = pullSession(sessionId, host, move);
      if (!pr.ff) { console.error(`CONFLICT: ${pr.reason}`); process.exit(2); }
      console.log("  [2/2] flip ownership back to this device + resume locally");
      await client.mutation(api.devices.moveSessionToDevice, {
        api_token: token, conversation_id: conv._id, owner_device_id: deviceId(),
        project_path: move.localCwd, resume: true,
      });
      console.log("  done — session is local again");
    });
}
