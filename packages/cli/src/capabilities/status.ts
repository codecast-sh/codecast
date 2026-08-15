// `cast cap status` — the fleet at a glance, one line per machine per client.

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "../publish.js";
import { formatDeviceMatrix, jsonShape, type DeviceStateRow } from "./format.js";

export function registerCapStatus(cap: Command, deps: PublishDeps): void {
  cap
    .command("status")
    .description("What every machine has installed, and how fresh each report is")
    .option("--json", "Machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      const rows: DeviceStateRow[] = await apiPost(deps, "/cli/cap/status", {}, { read: true });
      if (opts.json) {
        console.log(JSON.stringify(jsonShape(rows), null, 2));
        return;
      }
      console.log(formatDeviceMatrix(rows));
    });
}
