/**
 * `cast cloud start <conversation>` — the daemon's child for a web "run in
 * the cloud". The browser cannot SSH, so createQuickSession parks the row
 * (cloud_placement=pending) and hands a local daemon a cloud_spawn command;
 * that daemon runs this in a child process (a multi-minute SSH job must not
 * block its event loop) and this places the row exactly as `cast spawn
 * --cloud` would have.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { Command } from "commander";
import { hostForDevice } from "../browser/cloudHost.js";
import { convexClient } from "../remote/cli.js";
import {
  acquireRemoteWorkspace,
  freshWorktreeName,
  prepareCloudHost,
  waitForDeviceOnline,
} from "./prepare.js";

/** The model option key the launch flags want, from the row's full id. */
export function launchModelKey(model: string | null | undefined, agentType: string | null | undefined): string | undefined {
  if (!model) return undefined;
  return agentType === "claude_code" && model.startsWith("claude-") ? model.slice("claude-".length) : model;
}

export function registerCloudCommand(program: Command): void {
  const cloud = program.command("cloud", { hidden: true }).description("Cloud host plumbing used by the daemon");

  cloud
    .command("wake <hostId>")
    .description("Boot a sleeping host (the daemon runs this when work is queued for it)")
    .action(async (hostId: string) => {
      const { ensureUp, resolveCloudHost, toRemoteHost } = await import("../browser/cloudHost.js");
      const { learnHostDeviceId } = await import("./prepare.js");
      const cloud = resolveCloudHost(hostId);
      const say = (m: string) => console.log(`  ${m}`);
      const up = await ensureUp(cloud, say);
      const deviceId = await learnHostDeviceId(up, toRemoteHost(up));
      // A freshly booted box gets the home steps too (each non-fatal): the
      // work queued for it may run before any laptop-side prepare happens.
      const { readyHostHome } = await import("./prepare.js");
      await readyHostHome(toRemoteHost(up), { cloudId: up.id, onProgress: say });
      console.log(JSON.stringify({ host: up.id, address: up.address, device_id: deviceId ?? null }));
    });

  // The receiving end of the home mirror (cloud/mirror): a laptop streams one
  // bundle over ssh stdin and this merges it into THIS home under the mirror
  // lock. `--into <dir>` is the workspace staging mode used by copyCloudFiles:
  // verbatim writes into the inputs dir, no lock, no stamp, no refresh.
  cloud
    .command("mirror-run")
    .description("Run the local context mirror in a dedicated process")
    .action(async () => {
      const { runStandaloneMirror } = await import("./mirror/runner.js");
      await runStandaloneMirror();
    });

  cloud
    .command("mirror-apply")
    .description("Apply a home-mirror bundle from stdin (run on the host by the laptop's push)")
    .option("--stdin", "Read the bundle from stdin (the only transport)")
    .option("--verify", "Verify the saved mirror against actual destination files")
    .option("--into <dir>", "Staging mode: write every file verbatim under this directory")
    .action(async (opts: { stdin?: boolean; into?: string; verify?: boolean }) => {
      const { parseMirrorBundle } = await import("./mirror/bundle.js");
      const { applyMirrorBundle, applyStagingBundle, readStamp, verifyMirrorStamp, withMirrorLock } = await import("./mirror/apply.js");
      const os = await import("node:os");
      if (opts.verify) {
        const stamp = await withMirrorLock(os.homedir(), async () => verifyMirrorStamp(os.homedir()));
        console.log(JSON.stringify(stamp));
        return;
      }
      let bundle;
      try {
        bundle = await parseMirrorBundle(fs.createReadStream("", { fd: 0, autoClose: false }));
      } catch (err) {
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exit(1);
      }
      if (opts.into) {
        const into = opts.into;
        if (!into.startsWith("/") || /[\x00-\x1f\x7f]/.test(into)) {
          console.log(JSON.stringify({ error: "staging directory must be an absolute path" }));
          process.exit(1);
        }
        const r = applyStagingBundle(bundle, { into });
        console.log(JSON.stringify(r));
        process.exit(r.errors.length ? 1 : 0);
      }
      const home = os.homedir();
      let configUserId: string | undefined;
      try {
        const cfg = JSON.parse(fs.readFileSync(`${home}/.codecast/config.json`, "utf-8"));
        configUserId = typeof cfg?.user_id === "string" && cfg.user_id ? cfg.user_id : undefined;
      } catch { /* unprovisioned */ }
      try {
        const result = await withMirrorLock(home, () =>
          applyMirrorBundle(bundle, { home, configUserId, previousStamp: readStamp(home) }),
        );
        console.log(JSON.stringify(result));
        process.exit(result.refused ? 3 : result.errors.length || result.host_edited.length ? 1 : 0);
      } catch (err) {
        console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exit(1);
      }
    });

  cloud
    .command("start <conversationId>")
    .description("Prepare the cloud host and place a parked conversation on it (run by the daemon for web spawns)")
    .option("--device <id>", "The host's codecast device id (default: the row's owner)")
    .option("--host <id>", "Registry host id (default: the one whose device id matches)")
    .action(async (conversationId: string, opts: { device?: string; host?: string }) => {
      const { client, token, api } = await convexClient();
      const target = await client.query(api.cloud.placementTarget, { api_token: token, conversation_id: conversationId });
      if (!target) {
        console.error(`conversation ${conversationId} not found`);
        process.exit(1);
      }
      const localPath = target.git_root || target.project_path;
      if (!localPath || !fs.existsSync(localPath)) {
        console.error(`the conversation's project (${localPath ?? "none"}) is not on this machine — nothing to send to the host`);
        process.exit(1);
      }
      let localGitRoot = localPath;
      try {
        localGitRoot = execSync(`git -C "${localPath}" rev-parse --show-toplevel`, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      } catch {}
      const deviceId: string | undefined = opts.device ?? target.owner_device_id ?? undefined;
      const hostArg = opts.host ?? (deviceId ? hostForDevice(deviceId)?.id : undefined);

      const say = (m: string) => console.log(`  ${m}`);
      const prepared = await prepareCloudHost({ hostArg, localGitRoot, onProgress: say });
      if (deviceId && deviceId !== prepared.deviceId) {
        console.error(`the row is parked on device ${deviceId.slice(0, 8)} but host ${prepared.cloud.id} is device ${prepared.deviceId.slice(0, 8)}`);
        process.exit(1);
      }
      await waitForDeviceOnline(client, api, token, prepared.deviceId, say);
      const name = target.worktree_name || freshWorktreeName();
      say(`acquiring worktree ${name} on the host (install runs there)`);
      const ws = await acquireRemoteWorkspace(prepared.host, prepared.repoPath, name, prepared.localGitRoot);
      const r = await client.mutation(api.cloud.placeConversation, {
        api_token: token,
        conversation_id: conversationId,
        device_id: prepared.deviceId,
        project_path: ws.path,
        git_root: ws.path,
        worktree_name: ws.name,
        worktree_branch: ws.branch,
        worktree_path: ws.path,
        start: true,
        model: launchModelKey(target.model, target.agent_type),
        effort: target.effort ?? undefined,
        cc_account: target.cc_account ?? undefined,
      });
      console.log(JSON.stringify({ placed: true, device_id: prepared.deviceId, host: prepared.cloud.id, worktree: ws, command_id: r.command_id ?? null }));
    });
}
