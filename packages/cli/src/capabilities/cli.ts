// `cast cap` — the registrar, and nothing else.
//
// RULE: one module per verb (status.ts, ls.ts, show.ts; phase 2 adds add.ts,
// sync.ts, why.ts, token.ts), each exporting register<Verb>(cap, deps) plus
// pure formatters/filters for its tests. This file only assembles them. Nine
// tasks across the plan write this surface; without the split they serialize
// on one file, and with it a wave lands four verbs without a merge conflict.
//
// Never import index.ts (it runs program.parse() on import); deps arrive from
// index.ts the way publish.ts receives them.

import type { Command } from "commander";
import type { PublishDeps } from "../publish.js";
import { registerCapStatus } from "./status.js";
import { registerCapLs } from "./ls.js";
import { registerCapShow } from "./show.js";
import { registerCapEquip } from "./equip.js";

export function registerCapabilityCommand(program: Command, deps: PublishDeps): void {
  const cap = program
    .command("cap")
    .description("Capabilities across your machines: skills, plugins, MCP servers, hooks");
  registerCapStatus(cap, deps);
  registerCapLs(cap, deps);
  registerCapShow(cap, deps);
  registerCapEquip(cap, deps);
}
