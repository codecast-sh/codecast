/**
 * `cast computer …` as a process entry, reached from fastPath.ts before
 * index.ts is loaded.
 *
 * The group is placed and activated through the same code index.ts uses
 * (commandGroupActivation.ts), so its flags, help, unknown-verb suggestion and
 * managed-policy refusal are exactly the full CLI's. What it leaves out is the
 * lifecycle every other verb pays: the per-command server log (which decrypts
 * the auth token), the daemon start check, the update check and task
 * auto-binding. None of them is part of driving an app, and each runs on the
 * next ordinary `cast` command the agent types.
 */

import { Command } from "commander";
import { getVersion } from "../cliVersion.js";
import { activateGroup, registerGroupStubs } from "../commandGroupActivation.js";
import { groupForToken, type GroupDeps } from "../commandGroups.js";

export async function runComputerEntry(argv: string[]): Promise<void> {
  const group = groupForToken("computer")!;
  const program = new Command().name("cast").version(getVersion());
  registerGroupStubs(program, [group]);
  // The computer group's register function takes no deps (commandGroups.ts).
  await activateGroup(program, group.token, {} as GroupDeps);
  try {
    await program.parseAsync(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
