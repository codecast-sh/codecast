// Token lookup over COMMAND_GROUPS (commandGroups.ts): the group a first token or
// alias names, and the spec a group module reads its own description back from.
// Its own module because commandGroups.ts must stay a runtime leaf (see
// bench/bootGraph.guard.test.ts) and under its line cap.
import { COMMAND_GROUPS } from "./commandGroups.js";
import type { CommandGroup } from "./commandGroupTypes.js";

const BY_TOKEN = new Map<string, CommandGroup>();
for (const group of COMMAND_GROUPS) for (const token of [group.token, ...(group.aliases ?? [])]) BY_TOKEN.set(token, group);

/** The group a first token names, by token or by alias. */
export function groupForToken(token: string | undefined): CommandGroup | undefined {
  return token === undefined ? undefined : BY_TOKEN.get(token);
}

/** One group's spec, for the group module reading its own description back. */
export function commandGroup(token: string): CommandGroup {
  const group = BY_TOKEN.get(token);
  if (!group) throw new Error(`no command group named "${token}"`);
  return group;
}
