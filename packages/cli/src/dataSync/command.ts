// `cast datasync`: the folders every machine of yours shares, as your repos
// declare them ([host] data in .codecast/workspace.toml), and a pass on
// demand. The daemon runs the same pass every minute (dataSync/loop.ts).

import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { acquireLock, releaseLock } from "../capabilities/lock.js";
import { defaultConfigDir } from "../config/configDir.js";
import { readAuthConfig } from "../config/readAuthConfig.js";
import { deviceId } from "../remote/device.js";
import { commandGroup } from "../commandGroupLookup.js";
import { dataFolderFromManifest } from "@codecast/shared/contracts/dataSync";
import { convexDataSyncApi } from "./convexApi.js";
import { declarationsFor, paneProjectPaths } from "./declarations.js";
import { syncOnce, type DataSyncApi, type SyncReport } from "./engine.js";

export const dataSyncStateDir = (): string => path.join(defaultConfigDir(), "data-sync");

function liveApi(): DataSyncApi {
  const config = readAuthConfig(defaultConfigDir());
  if (!config?.auth_token || !config.convex_url) throw new Error("not signed in: run cast auth");
  return convexDataSyncApi({ convexUrl: config.convex_url, apiToken: config.auth_token, deviceId: deviceId() });
}

/**
 * One pass: declare what the repos around `dirs` ask for, then sync every
 * folder. Null when another pass holds the lock, which is the same work
 * already happening.
 */
export async function runDataSync(o: { dirs: string[]; api?: DataSyncApi; home?: string; log?: (line: string) => void }): Promise<SyncReport | null> {
  const stateDir = dataSyncStateDir();
  const lock = { name: "pass.lock", ceilingMs: 30 * 60_000 };
  fs.mkdirSync(stateDir, { recursive: true });
  if (!acquireLock(stateDir, () => {}, lock).acquired) return null;
  try {
    const api = o.api ?? liveApi();
    const declared = declarationsFor(o.dirs);
    if (declared.length) await api.declareFolders(declared);
    return await syncOnce({ home: o.home ?? (process.env.HOME || ""), stateDir, api, log: o.log });
  } finally {
    releaseLock(stateDir, lock);
  }
}

const mib = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`;

export function registerDataSyncCommand(program: Command): void {
  const cmd = program.command("datasync").description(commandGroup("datasync").description);

  cmd
    .command("ls", { isDefault: true })
    .description("The folders your machines share: where, declared by which repo, how much")
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const folders = await liveApi().folders();
      if (opts.json) return console.log(JSON.stringify(folders, null, 2));
      if (!folders.length) return console.log("No shared folders. A repo declares one in .codecast/workspace.toml:\n  [host]\n  data = [\"~/.local/share/<tool>/<dir>\"]");
      for (const f of folders) console.log(`~/${f.path}  ${f.files} files, ${mib(f.bytes)}${f.declared_by ? `  (${f.declared_by})` : ""}`);
    });

  cmd
    .command("add <dir>")
    .description("Share a folder under $HOME with every machine of yours, as a repo's [host] data would")
    .action(async (dir: string) => {
      const home = process.env.HOME || "";
      const absolute = path.resolve(dir.replace(/^~(?=\/|$)/, home));
      const folder = absolute.startsWith(`${home}/`) ? dataFolderFromManifest(`~/${path.relative(home, absolute)}`) : null;
      if (!folder) throw new Error(`${dir} cannot be shared: it must be a folder under $HOME, at least two levels deep, outside credential and agent folders`);
      await liveApi().declareFolders([{ path: folder }]);
      console.log(`~/${folder} now syncs on every machine of yours; this one sends its copy on the next pass (cast datasync now).`);
    });

  cmd
    .command("now")
    .description("Sync every shared folder now, declaring any the repo here asks for")
    .option("--quiet", "Print nothing unless something moved or failed")
    .option("--json", "Machine-readable output")
    .action(async (opts: { quiet?: boolean; json?: boolean }) => {
      const report = await runDataSync({ dirs: [process.cwd(), ...paneProjectPaths()], log: (l) => console.error(l) });
      if (!report) return console.log(opts.json ? "null" : "Another pass is running; it covers this one.");
      if (opts.json) return console.log(JSON.stringify(report));
      const moved = report.pulled + report.pushed + report.deletedHere;
      if (opts.quiet && !moved && !report.conflicts.length && !report.skipped.length) return;
      console.log(`${report.folders.length} folder(s): ${report.pulled} in, ${report.pushed} out, ${report.deletedHere} deleted here, ${report.conflicts.length} conflict(s)`);
      for (const s of report.skipped) console.log(`  skipped ${s}`);
    });
}
