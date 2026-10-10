// The CLI's own command tree, as the shipped binary reports it
// (`cast agent-context --json`), and the one rule for whether a line of words
// names a command in it. Tests that check text against the real surface
// (agentContext.test.ts, docsCommands.guard.test.ts) share this, so they all
// read the same tree the same way.

import { spawnSync } from "../proc.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext, AgentContextCommand } from "../agentContext.js";

// `cast browser` registers one of two verb sets depending on whether the
// agent-browser engine is installed on the machine (useEngine in browser/cli.ts),
// so a subcommand comparison is only meaningful with that choice pinned. Its own
// escape hatch pins it; callers that build their own program set it too.
export const PINNED_ENV = { CAST_BROWSER_LEGACY: "1" };

/** The dump the shipped CLI produces, with nothing of this machine in it: an
 *  empty HOME and its own CODECAST_DIR, so no config, credential or daemon of
 *  the developer running the test can reach the run. */
export function liveAgentContext(): AgentContext {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-agent-context-"));
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  try {
    const result = spawnSync(process.execPath, [path.join(import.meta.dir, "..", "main.ts"), "agent-context", "--json"], {
      env: {
        ...process.env,
        ...PINNED_ENV,
        HOME: home,
        CODECAST_DIR: path.join(home, ".codecast"),
        NO_COLOR: "1",
        CODECAST_NO_AUTO_UPDATE: "1",
      },
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      // Generous, because this run loads every command group and a busy machine
      // transpiles the whole CLI first. It bounds a hang, not the normal run.
      timeout: 300_000,
    });
    if (result.status !== 0) {
      throw new Error(`cast agent-context --json exited ${result.status}: ${result.stderr || result.stdout}`);
    }
    if (result.stderr) throw new Error(`cast agent-context --json wrote to stderr: ${result.stderr}`);
    return JSON.parse(result.stdout) as AgentContext;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Why the leading words of a `cast ...` line name no command, or null when they
 * do. The rule the dry-run guard (scripts/prompt-dry-run-bin/cast) applies:
 * walk the words down the tree; a word that leaves it is unknown at the root,
 * or under a group that only answers ("unknown command") rather than running
 * something (`runsBare` false). A word under a leaf or a runsBare group is an
 * argument, and so is anything that is not a plain lowercase word.
 */
export function unknownCommandWords(context: AgentContext, words: readonly string[]): string | null {
  const byPath = new Map<string, AgentContextCommand>(context.commands.map((cmd) => [cmd.command, cmd]));
  const byAlias = new Map<string, string>();
  for (const cmd of context.commands) {
    for (const alias of cmd.aliases) byAlias.set([...cmd.path.slice(0, -1), alias].join(" "), cmd.command);
  }
  let at = "";
  for (const word of words) {
    if (!/^[a-z][\w-]*$/.test(word)) return null;
    const next = at ? `${at} ${word}` : word;
    const real = byPath.has(next) ? next : byAlias.get(next);
    if (real) {
      at = real;
      continue;
    }
    if (!at) return `no command '${word}'`;
    const node = byPath.get(at)!;
    if (node.subcommands.length === 0 || node.runsBare) return null;
    return `'cast ${at}' has no subcommand '${word}'`;
  }
  return null;
}
