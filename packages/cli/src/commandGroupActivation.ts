/**
 * Placing the command groups in a program: a placeholder for each in the root
 * help, and the swap to the real registration once argv names one. The
 * manifest itself, and why groups load lazily, is commandGroups.ts.
 */

import type { Command } from "commander";
import { COMMAND_GROUPS, groupForToken, type CommandGroup, type GroupDeps } from "./commandGroups.js";

/**
 * The placeholder every group has in the tree until something names it.
 *
 * It carries exactly what `cast --help` and the typo suggester read. Argv that
 * names a group is activated before parsing starts, so a placeholder is never
 * the command that runs — and its action says so rather than exiting 0, because
 * a command group that silently did nothing would be far worse than one that
 * names the bug. Registered where the real registrations used to sit, so the
 * root help keeps its order.
 */
export function registerGroupStubs(program: Command): void {
  for (const group of COMMAND_GROUPS) {
    const cmd = program.command(group.token, { hidden: group.hidden === true }).description(group.description);
    for (const alias of group.aliases ?? []) cmd.alias(alias);
    for (const arg of group.args ?? []) cmd.argument(arg);
    // The help term reads "[options]" off the option COUNT, so a placeholder
    // for a command that takes options needs one to stand in for them.
    if (group.hasOptions) cmd.option("--placeholder", "placeholder");
    cmd.action(() => {
      console.error(`cast ${group.token} did not load (commandGroups.ts). Re-run it as the first word: cast ${group.token} …`);
      process.exit(1);
    });
  }
}

/**
 * Swaps a group's placeholder for the real registration, in place.
 *
 * Called before parsing, so commander only ever dispatches against the real
 * command: no double preAction, no second parse, and the group's own unknown
 * subcommand suggestions come from its real subcommand names. The real command
 * takes the placeholder's position so the root help keeps its order.
 */
export async function activateGroup(program: Command, token: string | undefined, deps: GroupDeps): Promise<boolean> {
  const group = groupForToken(token);
  if (!group) return false;
  const commands = program.commands as Command[];
  const at = commands.findIndex((cmd) => cmd.name() === group.token);
  if (at === -1) return false; // already activated, or stubs were never registered
  commands.splice(at, 1);
  const register = await group.load();
  register(program, deps);
  const registered = commands.pop();
  if (registered) commands.splice(at, 0, registered);
  // The group's aliases answer once it is real too, without each module repeating them.
  for (const alias of registered ? group.aliases ?? [] : []) if (!registered!.aliases().includes(alias)) registered!.alias(alias);
  if (registered && group.policy) guardWithPolicy(registered, group.policy);
  return true;
}

/** Refuse a group's verbs while its policy restriction is on. Help still prints. */
function guardWithPolicy(cmd: Command, policy: NonNullable<CommandGroup["policy"]>): void {
  cmd.hook("preAction", async (_root, action) => {
    // A group like publish takes its verbs as a positional rather than a subcommand.
    const verb = action === cmd ? action.args[0] : action.name();
    if (verb && policy.allow?.includes(verb)) return;
    const { exitIfPolicyBlocks } = await import("./config/managedPolicy.js");
    exitIfPolicyBlocks(policy.key);
  });
}

/**
 * The token argv names, if any: `cast browser open` and `cast help browser`
 * both name the browser group, `cast --help` and `cast send` name none.
 *
 * Leading flags are skipped so this and commander pick the same word. That is
 * the whole point: `cast -- publish x` is still `publish` to commander, and a
 * token this missed would leave commander dispatching a placeholder.
 */
export function groupTokenInArgv(argv: readonly string[]): string | undefined {
  let at = 2;
  while (argv[at]?.startsWith("-")) at++;
  return argv[at] === "help" ? argv[at + 1] : argv[at];
}

/** Every group, loaded. For a caller that needs the whole command tree at once
 *  — a spec dump, a coverage test — and is willing to pay for all of it. */
export async function activateAllGroups(program: Command, deps: GroupDeps): Promise<void> {
  for (const group of COMMAND_GROUPS) await activateGroup(program, group.token, deps);
}
