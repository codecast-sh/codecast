// `cast cap show <name>` — one capability in full, across every machine.
//
// This is the command an agent runs to learn what a capability is, which is
// exactly why every foreign string here goes through the fence: the Snyk audit
// that motivated the sanitizer found the attack payload living in the
// description field this command prints.

import type { Command } from "commander";
import { apiPost, type PublishDeps } from "../publish.js";
import { fenceUnlessBuiltin } from "./fence.js";
import { parseEntries, relativeAge, type DeviceStateRow } from "./format.js";

export function registerCapShow(cap: Command, deps: PublishDeps): void {
  cap
    .command("show <name>")
    .description("One capability in detail, on every machine that has it")
    .option("--json", "Machine-readable output")
    .action(async (name: string, opts: { json?: boolean }) => {
      const rows: DeviceStateRow[] = await apiPost(deps, "/cli/cap/status", {}, { read: true });
      const needle = name.toLowerCase();
      const hits = rows.flatMap((row) =>
        parseEntries(row)
          .items.filter(
            (e) => e.name.toLowerCase() === needle || e.slug?.toLowerCase() === needle,
          )
          .map((entry) => ({ entry, row })),
      );

      if (opts.json) {
        console.log(
          JSON.stringify(
            hits.map(({ entry, row }) => ({ device_id: row.device_id, client: row.client, ...entry })),
            null,
            2,
          ),
        );
        return;
      }
      if (hits.length === 0) {
        console.log(`Nothing named "${name}" on any machine. \`cast cap ls -q ${name}\` searches partial names.`);
        return;
      }

      const first = hits[0].entry;
      console.log(`${first.kind}  ${first.name}${first.slug ? `  (${first.slug})` : ""}`);
      if (first.description) {
        const provenance = first.meta?.marketplace
          ? `marketplace ${first.meta.marketplace}`
          : `${first.kind} ${first.name}`;
        console.log(fenceUnlessBuiltin(first.description, first.slug ?? "", provenance));
      }
      console.log("");
      for (const { entry, row } of hits) {
        const state = entry.enabled === false ? "off" : "on";
        const pin = entry.meta?.sha?.slice(0, 7) ?? entry.meta?.version ?? "";
        console.log(
          `  ${row.device_id}  ${entry.scope ?? "user"}  ${state}${pin ? `  ${pin}` : ""}  · reported ${relativeAge(row.reported_at)}`,
        );
      }
    });
}
