/**
 * `cast cloud start <conversation>` — the daemon's child for a web "run in
 * the cloud". The browser cannot SSH, so createQuickSession parks the row
 * (cloud_placement=pending) and hands a local daemon a cloud_spawn command;
 * that daemon runs this in a child process (a multi-minute SSH job must not
 * block its event loop) and this places the row exactly as `cast spawn
 * --cloud` would have.
 */

import * as fs from "node:fs";
import { writeStdout } from "../agentContext.js";
import type { Command } from "commander";
import { hostForDevice } from "../browser/cloudHost.js";
import { convexClient } from "../remote/cli.js";
import { normalizeCloudWorkspace, type CloudStartFrom, type CloudWorkspaceMode } from "@codecast/shared/contracts";
import {
  acquireRemoteRootCheckout,
  acquireRemoteWorkspace,
  freshWorktreeName,
  parseStartFrom,
  prepareCloudHost,
  refreshCloudCheckout,
  releaseRemoteWorkspace,
  resolveSeedRoots,
  sameGitOrigin,
  seedForHost,
  waitForDeviceOnline,
  wakeCloudHost,
  type CloudSeed,
} from "./prepare.js";
import { commandGroup } from "../commandGroups.js";
import { hostAccessPath, repoOrigin } from "./hostGit.js";

/**
 * The argv the daemon's cloud_spawn handler runs, from the command's args
 * JSON: `cast cloud start <id> [--device <id>] [--workspace <mode>] [--from
 * <checkout|origin-main>]`. The placement token is NOT an argv (the child
 * reads it from placementTarget); a workspace or start_from value that is
 * neither option is dropped (the child defaults to the row's stamp).
 */
export function cloudStartArgs(args: { conversation_id: string; cloud_device_id?: string | null; workspace?: string | null; start_from?: string | null }): string[] {
  return [
    "cloud", "start", args.conversation_id,
    ...(args.cloud_device_id ? ["--device", args.cloud_device_id] : []),
    ...(args.workspace === "shared" || args.workspace === "isolated" ? ["--workspace", args.workspace] : []),
    ...(args.start_from === "checkout" ? ["--from", "checkout"] : args.start_from === "origin_main" ? ["--from", "origin-main"] : []),
  ];
}

/** The `seed` argument of cloud.placeConversation / the `cloud_seed` body field, from a CloudSeed. */
export function seedPlacementArg(seed: CloudSeed): { source: CloudStartFrom; base: string; branch?: string; dirty?: boolean; laptop_root?: string; device_id?: string; reason?: string } {
  return {
    source: seed.source,
    base: seed.base,
    ...(seed.branch ? { branch: seed.branch } : {}),
    ...(seed.dirty !== undefined ? { dirty: seed.dirty } : {}),
    ...(seed.laptopRoot ? { laptop_root: seed.laptopRoot } : {}),
    ...(seed.deviceId ? { device_id: seed.deviceId } : {}),
    ...(seed.reason ? { reason: seed.reason } : {}),
  };
}

/** The model option key the launch flags want, from the row's full id. */
export function launchModelKey(model: string | null | undefined, agentType: string | null | undefined): string | undefined {
  if (!model) return undefined;
  return agentType === "claude_code" && model.startsWith("claude-") ? model.slice("claude-".length) : model;
}

/**
 * Whether the row `cast cloud start` was handed is still waiting to be
 * placed. A row the user re-pointed at a laptop (or that another child
 * already placed) before this child ran is not ours to prepare: the daemon
 * treats exit 0 + `{placed:false}` as a clean outcome.
 */
export function parkedRowStillPending(target: { cloud_placement?: string | null }): boolean {
  return target.cloud_placement === "pending";
}

/**
 * Why `cast cloud start` has nothing to do for this row, or null to proceed:
 * `not_pending` (re-pointed or placed already) and `no_path` (parked before a
 * folder was picked — the folder pick re-parks and asks again). Both are
 * `{placed:false}` on exit 0, so the daemon logs them instead of stamping a
 * session_error on the row.
 */
export function cloudStartSkipReason(
  target: { cloud_placement?: string | null; project_path?: string | null; git_root?: string | null },
): "not_pending" | "no_path" | null {
  if (!parkedRowStillPending(target)) return "not_pending";
  if (!target.git_root && !target.project_path) return "no_path";
  return null;
}

export function registerCloudCommand(program: Command): void {
  const cloud = program.command("cloud", { hidden: true }).description(commandGroup("cloud").description);

  cloud
    .command("browser-sync <hostDeviceId>")
    .description("Carry this laptop's browser login into a cloud host's Chrome (the daemon runs this for a host's `cast browser sync`)")
    .option("--port <n>", "The host Chrome's loopback CDP port")
    .option("--origin <origin>", "The site origin to carry")
    .option("--all", "Carry every site")
    .option("--conversation <id>", "The requesting conversation (attribution only)")
    .action(async (hostDeviceId: string, o: { port?: string; origin?: string; all?: boolean; conversation?: string }) => {
      const { carryLoginsToHost, carrySummaryLine, parseBrowserSyncArgs } = await import("./browserSync.js");
      // The child validates exactly what the daemon validated: the same JSON
      // shape, the same parser. Nothing but the summary line goes to stdout,
      // and it holds counts — never a cookie.
      let outcome;
      try {
        const args = parseBrowserSyncArgs(JSON.stringify({
          host_device_id: hostDeviceId,
          cdp_port: o.port !== undefined ? Number(o.port) : undefined,
          origin: o.origin ?? null,
          all: !!o.all,
          ...(o.conversation ? { conversation_id: o.conversation } : {}),
        }));
        outcome = await carryLoginsToHost(args);
      } catch (err) {
        outcome = { ok: false as const, reason: (err as Error).message };
      }
      console.log(carrySummaryLine(outcome));
      process.exit(outcome.ok ? 0 : 1);
    });

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
      // Step 1 there is the agent logins push (remote/agentAuth.ts) and the
      // host tools check: this is the path daemon.wakeCloudDevice runs, so a
      // laptop-mediated wake refreshes the host's logins without a new
      // daemon command. Skipped when no daemon answered (unprovisioned box).
      // Tools are checked, not installed: the daemon caps this command at
      // six minutes, and installs belong to provisioning and `cast hosts tools`.
      const { readyHostHome } = await import("./prepare.js");
      const { summarizeHostTools } = await import("./hostTools.js");
      const home = await readyHostHome(toRemoteHost(up), { cloudId: up.id, onProgress: say, skipLogins: !deviceId, toolsInstall: false });
      console.log(JSON.stringify({
        host: up.id, address: up.address, device_id: deviceId ?? null,
        logins_pushed: home.logins?.pushed ?? false,
        ...(home.logins && !home.logins.pushed && home.logins.reason ? { logins_reason: home.logins.reason } : {}),
        tools: home.tools ? summarizeHostTools(home.tools) : null,
      }));
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
        await writeStdout(JSON.stringify(stamp));
        return;
      }
      let bundle;
      try {
        bundle = await parseMirrorBundle(fs.createReadStream("", { fd: 0, autoClose: false }));
      } catch (err) {
        await writeStdout(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exit(1);
      }
      if (opts.into) {
        const into = opts.into;
        if (!into.startsWith("/") || /[\x00-\x1f\x7f]/.test(into)) {
          await writeStdout(JSON.stringify({ error: "staging directory must be an absolute path" }));
          process.exit(1);
        }
        const r = applyStagingBundle(bundle, { into });
        await writeStdout(JSON.stringify(r));
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
        await writeStdout(JSON.stringify(result));
        process.exit(result.refused ? 3 : result.errors.length || result.host_edited.length ? 1 : 0);
      } catch (err) {
        await writeStdout(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        process.exit(1);
      }
    });

  cloud
    .command("start <conversationId>")
    .description("Prepare the cloud host and place a parked conversation on it (run by the daemon for web spawns)")
    .option("--device <id>", "The host's codecast device id (default: the row's owner)")
    .option("--host <id>", "Registry host id (default: the one whose device id matches)")
    .option("--workspace <mode>", "isolated (own worktree on the host, default) or shared (the host's main checkout; claimed first, refused when in use or dirty)")
    .option("--from <source>", "What the worktree starts from: checkout (this machine's branch, HEAD and uncommitted changes; default) or origin-main")
    .action(async (conversationId: string, opts: { device?: string; host?: string; workspace?: string; from?: string }) => {
      const { client, token, api } = await convexClient();
      const target = await client.query(api.cloud.placementTarget, { api_token: token, conversation_id: conversationId });
      if (!target) {
        console.error(`conversation ${conversationId} not found`);
        process.exit(1);
      }
      const skip = cloudStartSkipReason(target);
      if (skip) {
        console.log(JSON.stringify({ placed: false, reason: skip }));
        process.exit(0);
      }
      const localPath = (target.git_root || target.project_path) as string;
      if (!fs.existsSync(localPath)) {
        console.error(`the conversation's project (${localPath}) is not on this machine — nothing to send to the host`);
        process.exit(1);
      }
      const { seedCwd, repoRoot } = resolveSeedRoots(localPath);
      const deviceId: string | undefined = opts.device ?? target.owner_device_id ?? undefined;
      const hostArg = opts.host ?? (deviceId ? hostForDevice(deviceId)?.id : undefined);

      const say = (m: string) => console.log(`  ${m}`);
      const mode: CloudWorkspaceMode = normalizeCloudWorkspace(opts.workspace ?? target.cloud_workspace);
      // A shared checkout never seeds from a laptop tree: the host's main
      // checkout is moved to origin/main, whatever the row asked for.
      let startFrom: CloudStartFrom;
      try {
        startFrom = mode === "shared" ? "origin_main" : parseStartFrom(opts.from ?? target.cloud_start_from);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      // Never seed a different repository than the row was created in: a
      // laptop whose checkout at that path points elsewhere sends nothing.
      const laptopOrigin = repoOrigin(repoRoot);
      if (target.git_remote_url && laptopOrigin && !sameGitOrigin(target.git_remote_url, laptopOrigin)) {
        console.error(`the conversation's repo is ${target.git_remote_url} but ${repoRoot} points at ${laptopOrigin} — not seeding a different repository`);
        process.exit(1);
      }
      const expectToken = target.cloud_placement_token ?? undefined;
      const launch = {
        model: launchModelKey(target.model, target.agent_type),
        effort: target.effort ?? undefined,
        cc_account: target.cc_account ?? undefined,
      };
      // `path` is the whole answer to "can this host push", because the key
      // is only one of the credentials that can: a host whose App token
      // answers pushes with read/write both false on the key.
      const gitAccess = (prepared: Awaited<ReturnType<typeof wakeCloudHost>>) => {
        const git = prepared.git;
        if (!git) return null;
        const { path } = hostAccessPath(git.access, git.app, prepared.cloud.forwardAgent === true);
        return {
          read: git.access.read,
          write: git.access.write,
          readonly: git.access.readonly === true,
          path,
          ...(git.app ? { app: { origin: git.app.origin, read: git.app.read, write: git.app.write } } : {}),
        };
      };

      if (mode === "shared") {
        // Claim BEFORE touching the checkout: the wake and the home steps
        // mutate nothing in the repo, so a refused claim (another session
        // holds the checkout; the row was re-parked) leaves the host as it
        // was. A throw here prints the server's message and exits 1 — the
        // daemon stamps it on the row as session_error, which by the
        // occupancy rule frees the checkout for the next claimant.
        const prepared = await wakeCloudHost({ hostArg, seedCwd, repoRoot, startFrom, onProgress: say });
        if (deviceId && deviceId !== prepared.deviceId) {
          console.error(`the row is parked on device ${deviceId.slice(0, 8)} but host ${prepared.cloud.id} is device ${prepared.deviceId.slice(0, 8)}`);
          process.exit(1);
        }
        const claim = await client.mutation(api.cloud.claimSharedCheckout, {
          api_token: token, conversation_id: conversationId, device_id: prepared.deviceId,
          project_path: prepared.repoPath, expect_token: expectToken,
        });
        if (claim.claimed === false) {
          console.log(JSON.stringify({ placed: false, reason: claim.reason, workspace: mode }));
          process.exit(0);
        }
        say(`claimed the host checkout ${prepared.repoPath} for this session`);
        refreshCloudCheckout(prepared, { moveHead: true }, say);
        await waitForDeviceOnline(client, api, token, prepared.deviceId, say);
        const branch = `codecast/${freshWorktreeName()}`;
        say(`preparing the host checkout on ${branch} (cast ws root: ports, secret files, install)`);
        const ws = await acquireRemoteRootCheckout(prepared.host, prepared.repoPath, prepared.seedCwd, branch, { onProgress: say });
        const seed = await seedForHost(prepared, { startFrom: "origin_main" });
        const r = await client.mutation(api.cloud.placeConversation, {
          api_token: token, conversation_id: conversationId, device_id: prepared.deviceId,
          project_path: ws.path, git_root: ws.path, worktree_branch: ws.branch,
          cloud_workspace: "shared", start: true, ...launch, expect_token: expectToken, seed: seedPlacementArg(seed),
        });
        if (r.placed === false) {
          // The root stays as prepared: nothing of this session's is in it yet.
          say(`the row was ${r.reason === "superseded" ? "re-parked" : "re-pointed"} while the host was being prepared — the checkout is left on ${ws.branch}`);
          console.log(JSON.stringify({ placed: false, reason: r.reason, workspace: mode, checkout: ws }));
          process.exit(0);
        }
        console.log(JSON.stringify({
          placed: true, device_id: prepared.deviceId, host: prepared.cloud.id, workspace: mode, checkout: ws, command_id: r.command_id ?? null,
          seed: seedPlacementArg(seed),
          git_access: gitAccess(prepared),
        }));
        return;
      }

      const prepared = await prepareCloudHost({ hostArg, seedCwd, repoRoot, startFrom, onProgress: say });
      if (deviceId && deviceId !== prepared.deviceId) {
        console.error(`the row is parked on device ${deviceId.slice(0, 8)} but host ${prepared.cloud.id} is device ${prepared.deviceId.slice(0, 8)}`);
        process.exit(1);
      }
      await waitForDeviceOnline(client, api, token, prepared.deviceId, say);
      const seed = await seedForHost(prepared, { startFrom });
      if (seed.reason) say(`starting from origin/main: ${seed.reason}`);
      else say(seed.source === "checkout" ? `seeding from ${seed.branch ?? "detached HEAD"} @ ${seed.base.slice(0, 8)}${seed.dirty ? " with uncommitted changes" : ""}` : `starting from origin/main @ ${seed.base.slice(0, 8)}`);
      const name = target.worktree_name || freshWorktreeName();
      say(`acquiring worktree ${name} on the host (install runs there)`);
      const ws = await acquireRemoteWorkspace(prepared.host, prepared.repoPath, name, prepared.seedCwd, seed, { onProgress: say });
      const r = await client.mutation(api.cloud.placeConversation, {
        api_token: token,
        conversation_id: conversationId,
        device_id: prepared.deviceId,
        project_path: ws.path,
        git_root: ws.path,
        worktree_name: ws.name,
        worktree_branch: ws.branch,
        worktree_path: ws.path,
        cloud_workspace: "isolated",
        seed: seedPlacementArg(ws.seed),
        start: true,
        ...launch,
        // Fenced placement: the token the park stamped. A row re-pointed or
        // re-parked while the ssh ran is refused, and the worktree we just
        // acquired is dropped rather than left holding the manifest's secrets.
        expect_token: expectToken,
      });
      if (r.placed === false) {
        say(`the row was ${r.reason === "superseded" ? "re-parked" : "re-pointed"} while the host was being prepared — removing worktree ${ws.name}`);
        const drop = releaseRemoteWorkspace(prepared.host, prepared.repoPath, ws.name);
        if (drop.error) say(drop.error);
        console.log(JSON.stringify({ placed: false, reason: r.reason, workspace: mode, worktree: ws.name, removed: drop.removed }));
        process.exit(0);
      }
      console.log(JSON.stringify({
        placed: true, device_id: prepared.deviceId, host: prepared.cloud.id, workspace: mode, worktree: ws, command_id: r.command_id ?? null,
        seed: seedPlacementArg(ws.seed),
        // What the host's own key can do against the origin, so the daemon's
        // [CLOUD] placed line says whether pushes from there will work.
        git_access: gitAccess(prepared),
      }));
    });
}
