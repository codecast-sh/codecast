/**
 * `cast migrate` — bulk session migration between a local machine and a
 * cloud host, in either direction.
 *
 *   cast migrate start --to <device> <session…>   create a batch (the web's
 *                                                 Settings → Migration does the same)
 *   cast migrate move <session> --to <device>     re-home one session onto another
 *                                                 laptop that has the checkout (the
 *                                                 web's Run on this device)
 *   cast migrate ls                               recent batches
 *   cast migrate show <batch>                     one batch, row by row
 *   cast migrate cancel <batch>                   cancel its queued rows
 *   cast migrate retry <batch>                    re-queue its failed rows
 *   cast migrate rehearse --to <device> <session…> dry-run moves on this machine:
 *                                                 what would fail, what the host lacks
 *   cast migrate bring <session> <path…>          bring more folders to a moved session's host
 *   cast migrate run <batch>                      the executor (the daemon
 *                                                 starts this detached)
 */

import type { Command } from "commander";
import { commandGroup } from "../commandGroups.js";
import { deviceId as localDeviceId } from "../remote/device.js";
import { convexClient } from "../remote/cli.js";
import * as os from "node:os";
import * as path from "node:path";
import type { MoveRehearsal } from "@codecast/shared/contracts/moveRehearsal";
import type { BroughtPath } from "../remote/session-move.js";
import { bringsByDefault } from "@codecast/shared/contracts/moveRehearsal";
import { createRunnerIo } from "./io.js";
import { hostResolver } from "./hosts.js";
import { matchDevices } from "./pickDevice.js";
import { formatBytes, rehearseMove } from "./rehearse.js";
import { runBatch } from "./runner.js";

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function deviceName(devices: any[], id: string | null | undefined): string {
  if (!id) return "unknown";
  const d = devices.find((x) => x.device_id === id);
  return d ? `${d.label ?? d.hostname ?? id.slice(0, 8)}${d.is_remote ? " (cloud)" : ""}` : id.slice(0, 8);
}

/** The one device `needle` names; otherwise say why not, list the candidates, and exit. */
function pickDevice(devices: any[], needle: string, what: string): any {
  const matches = matchDevices(devices, needle);
  if (matches.length === 1) return matches[0];
  console.error(matches.length === 0 ? `no device matches ${what} "${needle}"` : `${what} "${needle}" matches ${matches.length} devices; be more specific:`);
  for (const d of matches.length ? matches : devices) console.error(`  ${d.device_id.slice(0, 8)}  ${d.label ?? d.hostname ?? ""}${d.is_remote ? " (cloud)" : ""}${d.online ? "" : "  offline"}`);
  process.exit(1);
}

function printBatch(b: any, devices: any[]): void {
  console.log(`${b.batch_id}  → ${deviceName(devices, b.to_device_id)}  ${b.state}  ${b.done}/${b.total} done${b.failed ? `, ${b.failed} failed` : ""}${b.cancelled ? `, ${b.cancelled} cancelled` : ""}  created ${ago(b.created_at)}`);
  for (const r of b.rows) {
    const where = `${deviceName(devices, r.from_device_id)} → ${deviceName(devices, r.to_device_id)}`;
    const line = r.error ? `— ${r.error}` : r.stage ? `— ${r.stage}` : "";
    console.log(`  ${(r.short_id ?? r.conversation_id.slice(0, 8)).padEnd(9)} ${r.status.padEnd(12)} ${where}  ${line}`);
  }
}

/** A rehearsal as a person reads it in a terminal. */
export function printRehearsal(r: MoveRehearsal, title: string): void {
  console.log(`${title}`);
  console.log(`  transfer   ${r.transfer.method === "git" ? "git" : `files, ${formatBytes(r.transfer.bytes)}`}${r.transfer.note ? ` (${r.transfer.note})` : ""}`);
  for (const b of r.blockers) console.log(`  BLOCKED    ${b}`);
  for (const m of r.missing) console.log(`  missing    ${m.path}  ${m.kind}, ${formatBytes(m.bytes)}, ${m.writes ? `${m.writes} writes` : `${m.uses} uses`}${bringsByDefault(m) ? "  (bring it: --bring)" : ""}`);
  for (const sv of r.services) console.log(`  service    ${sv.label}${sv.running ? " keeps running here" : " (not loaded)"}`);
  const absent = r.tools.missing.filter((t) => !r.tools.installs.includes(t));
  if (r.tools.installs.length) console.log(`  installs   ${r.tools.installs.join(", ")}`);
  if (absent.length) console.log(`  host lacks ${absent.join(", ")}`);
  for (const m of r.machine) console.log(`  machine    ${m}`);
  if (!r.blockers.length && !r.missing.length && !absent.length && !r.machine.length && !r.services.some((s) => s.running)) console.log("  nothing missing on the host");
}

export function registerMigrateCommand(program: Command): void {
  const migrate = program
    .command("migrate")
    .description(commandGroup("migrate").description);

  migrate
    .command("start [sessions...]")
    .description("Migrate sessions to a device as one batch — by short id, or by selector (--label, --from, --project, --all)")
    .requiredOption("--to <device>", "Destination: a device id (prefix) or label substring")
    .option("--label <name>", "Every session filed under this label")
    .option("--from <device>", "Every session running on this device (id prefix or label substring)")
    .option("--project <path|name>", "Sessions in this project (a path, or a substring of the repo name)")
    .option("--all", "Every movable session")
    .option("--dry-run", "Plan only: print what would move and what would be skipped, and why")
    .option("--wait <minutes>", "How long to wait for a mid-turn session to finish before interrupting it", "10")
    .option("--concurrency <n>", "Sessions transferred in parallel", "2")
    .option("--bring <path...>", "Also bring these repositories or folders to the host (cast migrate rehearse names the ones a session works in)")
    .option("--json", "Machine-readable")
    .action(async (sessions: string[], opts: { to: string; label?: string; from?: string; project?: string; all?: boolean; dryRun?: boolean; wait: string; concurrency: string; bring?: string[]; json?: boolean }) => {
      const { client, token, api } = await convexClient();
      const devices: any[] = await client.query(api.devices.listDevices, { api_token: token });
      const to = pickDevice(devices, opts.to, "--to");
      const from = opts.from ? pickDevice(devices, opts.from, "--from") : undefined;
      const selector = (opts.label || from || opts.project || opts.all)
        ? { ...(opts.label ? { label: opts.label } : {}), ...(from ? { from_device_id: from.device_id } : {}), ...(opts.project ? { project: opts.project } : {}), ...(opts.all ? { all: true } : {}) }
        : undefined;
      if (!sessions.length && !selector) {
        console.error("name sessions (short ids) or pick them with --label / --from / --project / --all");
        process.exit(1);
      }
      const res = await client.mutation(api.sessionMigrations.createBatch, {
        api_token: token,
        ...(sessions.length ? { conversation_ids: sessions } : {}),
        ...(selector ? { selector } : {}),
        to_device_id: to.device_id,
        wait_for_idle_ms: Math.max(0, Number(opts.wait) || 0) * 60_000,
        concurrency: Number(opts.concurrency) || 2,
        ...(opts.bring?.length ? { bring_paths: opts.bring.map((p) => path.resolve(p)) } : {}),
        dry_run: !!opts.dryRun,
      });
      if (opts.json) { console.log(JSON.stringify(res, null, 2)); if (!res.batch_id && !res.dry_run) process.exit(1); return; }
      const name = (r: any) => `${(r.short_id ?? r.conversation_id.slice(0, 8)).padEnd(9)} ${r.title ? r.title.slice(0, 60) : ""}`.trimEnd();
      for (const r of res.rows) console.log(`  ${res.dry_run ? "would move" : "moving"}  ${name(r)}  (${deviceName(devices, r.from_device_id)} → ${deviceName(devices, r.to_device_id)})${r.waits_for ? `, starts when ${r.waits_for} comes online` : ""}`);
      for (const s of res.skipped) console.log(`  skip       ${name(s)}: ${s.reason}`);
      if (res.dry_run) {
        console.log(`dry run: ${res.rows.length} would move to ${deviceName(devices, to.device_id)}, ${res.skipped.length} skipped`);
        // The rows this machine would carry are rehearsed here, as the runner will before it stops each one.
        const mine = res.rows.filter((r: any) => r.direction === "to_cloud" && r.executor_device_id === localDeviceId() && r.session_id);
        if (mine.length) {
          const resolve = hostResolver(() => {});
          const { cloud, host } = await resolve(to.device_id);
          for (const r of mine) {
            try {
              printRehearsal(await rehearseMove(r.session_id, { host, cloud, destinationId: to.device_id, bring: opts.bring?.map((p) => path.resolve(p)) }), name(r));
            } catch (err) {
              console.log(`${name(r)}\n  rehearsal failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        return;
      }
      if (!res.batch_id) { console.error("nothing to migrate"); process.exit(1); }
      console.log(`batch ${res.batch_id}: ${res.rows.length} session(s) → ${deviceName(devices, to.device_id)}`);
      console.log(`  watch: cast migrate show ${res.batch_id}`);
    });

  migrate
    .command("move <session>")
    .description("Re-home one session onto another laptop that already has the checkout, and resume it there (the web's Run on this device). Interrupts a turn in progress; for a cloud host use `start`")
    .requiredOption("--to <device>", "Destination: a device id (prefix) or label substring")
    .option("--json", "Machine-readable")
    .action(async (session: string, opts: { to: string; json?: boolean }) => {
      const { client, token, api } = await convexClient();
      const devices: any[] = await client.query(api.devices.listDevices, { api_token: token });
      const to = pickDevice(devices, opts.to, "--to");
      if (to.is_remote) {
        console.error(`${deviceName(devices, to.device_id)} is a cloud host: its files must be transferred, so use \`cast migrate start --to ${opts.to} ${session}\``);
        process.exit(1);
      }
      const r = await client.mutation(api.devices.reassignToDevice, { api_token: token, conversation_id: session, device_id: to.device_id });
      if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
      console.log(`${session} → ${deviceName(devices, to.device_id)}${to.online ? "" : " (offline)"}`);
    });

  migrate
    .command("ls")
    .description("Recent migration batches")
    .option("--json", "Machine-readable")
    .action(async (opts: { json?: boolean }) => {
      const { client, token, api } = await convexClient();
      const batches: any[] = (await client.query(api.sessionMigrations.listBatches, { api_token: token })) ?? [];
      if (opts.json) { console.log(JSON.stringify(batches, null, 2)); return; }
      if (batches.length === 0) { console.log("no migration batches yet"); return; }
      const devices: any[] = await client.query(api.devices.listDevices, { api_token: token });
      for (const b of batches) {
        console.log(`${b.batch_id}  → ${deviceName(devices, b.to_device_id)}  ${b.state.padEnd(9)} ${b.done}/${b.total} done${b.failed ? `, ${b.failed} failed` : ""}  ${ago(b.created_at)}`);
      }
    });

  migrate
    .command("show <batchId>")
    .description("One batch, row by row")
    .option("--json", "Machine-readable")
    .action(async (batchId: string, opts: { json?: boolean }) => {
      const { client, token, api } = await convexClient();
      const batches: any[] = (await client.query(api.sessionMigrations.listBatches, { api_token: token })) ?? [];
      const b = batches.find((x) => x.batch_id === batchId);
      if (!b) { console.error(`no batch ${batchId} among your recent batches`); process.exit(1); }
      if (opts.json) { console.log(JSON.stringify(b, null, 2)); return; }
      const devices: any[] = await client.query(api.devices.listDevices, { api_token: token });
      printBatch(b, devices);
    });

  migrate
    .command("cancel <batchId>")
    .description("Cancel a batch's queued rows (rows already transferring finish)")
    .action(async (batchId: string) => {
      const { client, token, api } = await convexClient();
      const r = await client.mutation(api.sessionMigrations.cancelBatch, { api_token: token, batch_id: batchId });
      console.log(`cancelled ${r.cancelled} queued row(s)`);
    });

  migrate
    .command("retry <batchId>")
    .description("Re-queue a batch's failed rows (a batch from the offload review moves again as a new batch)")
    .action(async (batchId: string) => {
      const { client, token, api } = await convexClient();
      const batches: any[] = (await client.query(api.sessionMigrations.listBatches, { api_token: token })) ?? [];
      const b = batches.find((x) => x.batch_id === batchId);
      if (b?.resource_offload) {
        // The review's confirmations belong to that review, so its batch is not
        // re-run as is: the failed sessions move as a batch of their own, which
        // the runner rehearses before stopping each.
        const failed = b.rows.filter((r: any) => r.status === "failed" || r.status === "cancelled");
        if (!failed.length) { console.log("no failed rows to retry"); return; }
        const bring = [...new Set(failed.flatMap((r: any) => b.resource_offload.selections.find((sel: any) => sel.conversation_id === r.conversation_id)?.bring ?? []))];
        const res = await client.mutation(api.sessionMigrations.createBatch, {
          api_token: token, conversation_ids: failed.map((r: any) => r.conversation_id), to_device_id: b.to_device_id,
          wait_for_idle_ms: b.wait_for_idle_ms, ...(bring.length ? { bring_paths: bring } : {}),
        });
        for (const s of res.skipped) console.log(`  skip ${s.conversation_id}: ${s.reason}`);
        console.log(res.batch_id ? `moving ${res.rows.length} session(s) again as ${res.batch_id}\n  watch: cast migrate show ${res.batch_id}` : "nothing to retry");
        return;
      }
      const r = await client.mutation(api.sessionMigrations.retryFailed, { api_token: token, batch_id: batchId });
      console.log(`re-queued ${r.requeued} row(s)`);
    });

  migrate
    .command("rehearse [sessions...]")
    .description("Dry-run moving sessions from this machine: what would fail, and what the host lacks that they use")
    .option("--to <device>", "Destination: a device id (prefix) or label substring")
    .option("--bring <path...>", "Paths the move would bring (not reported missing)")
    .option("--request <id>", "Run the rows of an offload review's request and report them (the daemon starts this)")
    .option("--json", "Machine-readable")
    .action(async (sessions: string[], opts: { to?: string; bring?: string[]; request?: string; json?: boolean }) => {
      const { client, token, api } = await convexClient();
      const resolve = hostResolver((line) => { if (!opts.json) console.error(line); });
      if (opts.request) {
        const rows: any[] = (await client.query(api.moveRehearsals.forRunner, { api_token: token, request_id: opts.request, device_id: localDeviceId() })) ?? [];
        for (const r of rows) {
          try {
            const { cloud, host } = await resolve(r.destination_id);
            const result = await rehearseMove(r.session_id, { host, cloud, destinationId: r.destination_id });
            await client.mutation(api.moveRehearsals.report, { api_token: token, rehearsal_id: r.rehearsal_id, result: JSON.stringify(result) });
            console.log(`${r.session_id}: ${result.blockers.length} blockers, ${result.missing.length} missing`);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await client.mutation(api.moveRehearsals.report, { api_token: token, rehearsal_id: r.rehearsal_id, error: message });
            console.log(`${r.session_id}: rehearsal failed: ${message}`);
          }
        }
        return;
      }
      if (!opts.to || !sessions.length) { console.error("name sessions and --to <device> (or --request <id>)"); process.exit(1); }
      const devices: any[] = await client.query(api.devices.listDevices, { api_token: token });
      const n = opts.to.toLowerCase();
      const to = devices.filter((d) => d.device_id.toLowerCase().startsWith(n) || String(d.label ?? "").toLowerCase().includes(n));
      if (to.length !== 1) { console.error(`--to "${opts.to}" matches ${to.length} devices`); process.exit(1); }
      const plan = await client.mutation(api.sessionMigrations.createBatch, { api_token: token, conversation_ids: sessions, to_device_id: to[0].device_id, dry_run: true });
      for (const s of plan.skipped) console.error(`skip ${s.conversation_id}: ${s.reason}`);
      const { cloud, host } = await resolve(to[0].device_id);
      const out: MoveRehearsal[] = [];
      for (const r of plan.rows.filter((x: any) => x.session_id)) {
        const result = await rehearseMove(r.session_id, { host, cloud, destinationId: to[0].device_id, bring: opts.bring?.map((p) => path.resolve(p)) });
        out.push(result);
        if (!opts.json) printRehearsal(result, `${r.short_id ?? r.conversation_id} ${r.title ?? ""}`.trim());
      }
      if (opts.json) console.log(JSON.stringify(out, null, 2));
    });

  migrate
    .command("bring <session> <paths...>")
    .description("Bring repositories or folders from this machine to the cloud host a session now runs on, and tell the session")
    .action(async (session: string, paths: string[]) => {
      const { client, token, api } = await convexClient();
      // A dry run of moving it here names where it runs now (from_device_id).
      const plan = await client.mutation(api.sessionMigrations.createBatch, { api_token: token, conversation_ids: [session], to_device_id: localDeviceId(), dry_run: true });
      const row = plan.rows[0];
      if (!row) { console.error(plan.skipped[0]?.reason ?? `no session ${session}`); process.exit(1); }
      if (row.direction !== "to_local" || !row.from_device_id) { console.error("that session runs on this machine; bring paths with a move (cast migrate start --bring)"); process.exit(1); }
      const { pushPath } = await import("../remote/session-move.js");
      const { host } = await hostResolver((line) => console.error(line))(row.from_device_id);
      const brought: BroughtPath[] = [];
      for (const p of paths) {
        const b = await pushPath(host, path.resolve(p));
        brought.push(b);
        console.log(b.error ? `  FAILED ${b.local}: ${b.error}` : `  brought ${b.local} → ${b.remote} (${b.kind})`);
      }
      const { readMoves, writeMoves, sendMoveNotice } = await import("../remote/cli.js");
      const moves = readMoves();
      const sid = row.session_id;
      if (sid && moves[sid]) {
        const kept = (moves[sid].brought ?? []).filter((b: any) => !brought.some((n) => n.local === b.local));
        moves[sid] = { ...moves[sid], brought: [...kept, ...brought.filter((b) => !b.error)] };
        writeMoves(moves);
      }
      const landed = brought.filter((b) => !b.error);
      if (landed.length) {
        await sendMoveNotice(client, api, token, row.conversation_id,
          `[codecast] Brought from ${os.hostname()} to this machine, the same way a move carries a working tree: ${landed.map((b) => `${b.local} → ${b.remote} (${b.kind === "repo" ? "repository" : "folder, without what git ignores"})`).join("; ")}.`);
      }
      if (brought.some((b) => b.error)) process.exit(3);
    });

  migrate
    .command("run <batchId>")
    .description("Execute this machine's rows of a batch (the daemon starts this for you)")
    .option("--concurrency <n>", "Override the batch's parallelism")
    .action(async (batchId: string, opts: { concurrency?: string }) => {
      if (!/^mg-[a-z0-9]{4,32}$/.test(batchId)) { console.error(`invalid batch id ${batchId}`); process.exit(2); }
      const io = createRunnerIo(batchId);
      await io.ready();
      io.log(`runner pid ${process.pid} on device ${localDeviceId().slice(0, 8)}`);
      const outcomes = await runBatch(io, opts.concurrency ? { concurrency: Number(opts.concurrency) } : {});
      process.exit(outcomes.some((o) => o.outcome === "failed") ? 3 : 0);
    });
}
