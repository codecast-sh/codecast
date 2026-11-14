/**
 * `cast cloud`: move this laptop's working environment to a cloud machine in
 * one command and say exactly what made it.
 *
 *   cast cloud --dry-run        what would carry and what stays, nothing written
 *   cast cloud                  carry it to this person's machine on codecast's account (launched on first use)
 *   cast cloud --host <id>      carry it to a registered host instead
 *
 * The run reads the laptop (env/inventory.ts), applies it (env/apply.ts) and
 * prints the parity report (env/parity.ts). The report is also written as
 * JSON and HTML under ~/.codecast/cloud/.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import type { Command } from "commander";
import { readLocalConfig } from "../../config/readLocalConfig.js";
import { ParityLedger, renderParityText, type ParityReport } from "./parity.js";
import { DEFAULT_DAYS, readLaptopEnvironment } from "./inventory.js";
import { renderParityHtml } from "./parityHtml.js";

export interface CloudEnvOptions {
  host?: string;
  dryRun?: boolean;
  days?: string;
  all?: boolean;
  json?: boolean;
  only?: string;
}

export function reportDir(home = os.homedir()): string {
  return path.join(home, ".codecast", "cloud");
}

/** Write the report as JSON and HTML; returns the HTML path. */
export function saveReport(report: ParityReport, dir = reportDir()): { json: string; html: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = report.created_at.replace(/[:.]/g, "-");
  const json = path.join(dir, `parity-${stamp}.json`);
  const html = path.join(dir, `parity-${stamp}.html`);
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  fs.writeFileSync(html, renderParityHtml(report), { mode: 0o600 });
  fs.copyFileSync(json, path.join(dir, "latest.json"));
  fs.copyFileSync(html, path.join(dir, "latest.html"));
  return { json, html };
}

export async function runCloudEnv(opts: CloudEnvOptions): Promise<ParityReport> {
  const days = opts.days ? Number(opts.days) : DEFAULT_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error("--days must be a whole number from 1 to 365");
  const home = process.env.HOME || os.homedir();
  const config = readLocalConfig();
  const log = (line: string) => { if (!opts.json) console.error(line); };
  const { deviceId: localDeviceId } = await import("../../remote/device.js");

  // The target first, so a run that cannot reach it stops before reading anything.
  let target: { cloudId: string; host: import("../../remote/session-move.js").RemoteHost } | undefined;
  if (!opts.dryRun) {
    const { resolveCloudHost, ensureUp, toRemoteHost } = await import("../../browser/cloudHost.js");
    // No --host: this person's own machine in codecast's account, launched on first use.
    const cloud = opts.host ? resolveCloudHost(opts.host) : await (await import("./managedHost.js")).managedHost(log);
    log(`waking ${cloud.id}`);
    const up = await ensureUp(cloud, (l: string) => log(`  ${l}`));
    target = { cloudId: up.id, host: toRemoteHost(up) };
  }

  const ledger = new ParityLedger();
  const plan = await readLaptopEnvironment(ledger, {
    home, now: Date.now(), days, config, dryRun: opts.dryRun,
    ...(opts.only ? { only: opts.only.split(",").map((p) => p.trim().replace(/^~(?=\/|$)/, home)).filter(Boolean) } : {}),
    ...(config?.user_id ? { userId: config.user_id, deviceId: localDeviceId() } : {}),
    log,
  });
  if (target) {
    const { applyEnvironment } = await import("./apply.js");
    await applyEnvironment(ledger, plan, { host: target.host, cloudId: target.cloudId, home, log });
  }
  return ledger.finish({ laptop: os.hostname().replace(/\.local$/, ""), target: target?.cloudId ?? "dry run", dryRun: opts.dryRun });
}

/** The options, listed under the group's help (they are parsed here, see below). */
export const CLOUD_ENV_HELP = `
Options:
  --host <id>      carry to this registered host (cast hosts ls) instead of your own machine
                   on codecast's account, which the first run launches
  --dry-run        list what would carry and what would stay, changing nothing
  --only <paths>   comma-separated repositories or folders to carry instead of every one
                   sessions used; agent config, logins and tools still travel
  --days <n>       how far back sessions count when finding what you work on (default ${DEFAULT_DAYS})
  --all            list every item, not only the ones that did not make it
  --json           print the report as JSON`;

/** `cast cloud`'s own flags. Parsed by hand: declared on the group, Commander would take them from its subcommands too (`cast cloud start --host`, `cast cloud seed --json`). */
export function parseCloudEnvArgs(args: string[]): CloudEnvOptions {
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true,
    options: { host: { type: "string" }, "dry-run": { type: "boolean" }, only: { type: "string" }, days: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } },
  });
  if (positionals.length) throw new Error(`unknown command ${positionals[0]} (cast cloud --help)`);
  return { host: values.host, dryRun: values["dry-run"], only: values.only, days: values.days, all: values.all, json: values.json };
}

export function registerCloudEnvAction(cloud: Command): void {
  cloud
    .allowUnknownOption()
    .allowExcessArguments()
    .addHelpText("after", CLOUD_ENV_HELP)
    .action(async (_o: unknown, cmd: Command) => {
      let opts: CloudEnvOptions;
      try { opts = parseCloudEnvArgs(cmd.args); } catch (e) { console.error((e as Error).message); process.exit(2); }
      const { exitIfPolicyBlocks } = await import("../../config/managedPolicy.js");
      exitIfPolicyBlocks("cloud_hosts_disabled");
      let report: ParityReport;
      try {
        report = await runCloudEnv(opts);
      } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
      }
      const saved = saveReport(report);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(renderParityText(report, { all: opts.all }));
        console.log(`\nFull report: ${saved.html}`);
      }
      if (report.counts.failed) process.exit(3);
    });
}
