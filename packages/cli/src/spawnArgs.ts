// `cast spawn --subagent [parent]`: commander reads the next bare word as the
// parent, so `cast spawn --subagent "audit the auth flow"` spent the task on
// the parent and failed with "missing required argument 'prompts'". A session
// id is one word; a value with whitespace (or the stdin marker `-`) is a task,
// so it goes back in front of the prompts and the worker nests under the
// session running the command.
//
// The program's preAction hook expands '-' values before the action runs, but
// it saw this one as the parent, not as a prompt. So a recovered '-' is
// expanded here, or the worker's whole task would be the literal "-".

import { expandStdinArgs } from "./sendBody.js";

export function recoverSwallowedPrompt(
  prompts: string[] | undefined,
  subagent: unknown,
  readStdin?: () => string,
): { prompts: string[]; subagent: unknown } {
  if (typeof subagent === "string" && (/\s/.test(subagent) || subagent === "-")) {
    const recovered = [subagent, ...(prompts ?? [])];
    return { prompts: subagent === "-" ? expandStdinArgs(recovered, readStdin) : recovered, subagent: true };
  }
  return { prompts: prompts ?? [], subagent };
}
