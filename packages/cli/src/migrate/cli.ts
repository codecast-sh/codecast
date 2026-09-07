/**
 * `cast migrate` — bulk session migration between a local machine and a
 * cloud host, in either direction.
 *
 *   cast migrate start --to <device> <session…>   create a batch (the web's
 *                                                 Settings → Migration does the same)
 *   cast migrate ls                               recent batches
 *   cast migrate show <batch>                     one batch, row by row
 *   cast migrate cancel <batch>                   cancel its queued rows
 *   cast migrate retry <batch>                    re-queue its failed rows
 *   cast migrate run <batch>                      the executor (the daemon
 *                                                 starts this detached)
 */

import type { Command } from "commander";
import { deviceId as localDeviceId } from "../remote/device.js";
import { convexClient } from "../remote/cli.js";
import { createRunnerIo } from "./io.js";
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

function printBatch(b: any, devices: any[]): void {
  console.log(`${b.batch_id}  → ${deviceName(devices, b.to_device_id)}  ${b.state}  ${b.done}/${b.total} done${b.failed ? `, ${b.failed} failed` : ""}${b.cancelled ? `, ${b.cancelled} cancelled` : ""}  created ${ago(b.created_at)}`);
  for (const r of b.rows) {
    const where = `${deviceName(devices, r.from_device_id)} → ${deviceName(devices, r.to_device_id)}`;
    const line = r.error ? `— ${r.error}` : r.stage ? `— ${r.stage}` : "";
    console.log(`  ${(r.short_id ?? r.conversation_id.slice(0, 8)).padEnd(9)} ${r.status.padEnd(12)} ${where}  ${line}`);
  }
}

export function registerMigrateCommand(program: Command): void {
  const migrate = program
    .command("migrate")
    .description("Move many sessions between this machine and a cloud host at once");

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
    .option("--json", "Machine-readable")
    .action(async (sessions: string[], opts: { to: string; label?: string; from?: string; project?: string; all?: boolean; dryRun?: boolean; wait: string; concurrency: string; json?: boolean }) => {
      const { client, token, api } = await convexClient();
      const devices: any[] = await client.query(api.devices.listDevices, { api_token: token });
      const pickDevice = (needle: string, what: string): any => {
        const n = needle.toLowerCase();
        const matches = devices.filter((d) =>
          d.device_id.toLowerCase().startsWith(n) ||
          String(d.label ?? "").toLowerCase().includes(n) ||
          String(d.hostname ?? "").toLowerCase().includes(n) ||
          (n === "cloud" && d.is_remote));
        if (matches.length === 1) return matches[0];
        console.error(matches.length === 0 ? `no device matches ${what} "${needle}"` : `${what} "${needle}" matches ${matches.length} devices; be more specific:`);
        for (const d of matches.length ? matches : devices) console.error(`  ${d.device_id.slice(0, 8)}  ${d.label ?? d.hostname ?? ""}${d.is_remote ? " (cloud)" : ""}${d.online ? "" : "  offline"}`);
        process.exit(1);
      };
      const to = pickDevice(opts.to, "--to");
      const from = opts.from ? pickDevice(opts.from, "--from") : undefined;
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
        dry_run: !!opts.dryRun,
      });
      if (opts.json) { console.log(JSON.stringify(res, null, 2)); if (!res.batch_id && !res.dry_run) process.exit(1); return; }
      const name = (r: any) => `${(r.short_id ?? r.conversation_id.slice(0, 8)).padEnd(9)} ${r.title ? r.title.slice(0, 60) : ""}`.trimEnd();
      for (const r of res.rows) console.log(`  ${res.dry_run ? "would move" : "moving"}  ${name(r)}  (${deviceName(devices, r.from_device_id)} → ${deviceName(devices, r.to_device_id)})`);
      for (const s of res.skipped) console.log(`  skip       ${name(s)}: ${s.reason}`);
      if (res.dry_run) {
        console.log(`dry run: ${res.rows.length} would move to ${deviceName(devices, to.device_id)}, ${res.skipped.length} skipped`);
        return;
      }
      if (!res.batch_id) { console.error("nothing to migrate"); process.exit(1); }
      console.log(`batch ${res.batch_id}: ${res.rows.length} session(s) → ${deviceName(devices, to.device_id)}`);
      console.log(`  watch: cast migrate show ${res.batch_id}`);
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
    .description("Re-queue a batch's failed rows")
    .action(async (batchId: string) => {
      const { client, token, api } = await convexClient();
      const r = await client.mutation(api.sessionMigrations.retryFailed, { api_token: token, batch_id: batchId });
      console.log(`re-queued ${r.requeued} row(s)`);
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
