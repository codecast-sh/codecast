/**
 * `cast agent-context --json`: the whole command surface, serialized from the
 * live commander tree.
 *
 * An agent that has to guess at the CLI guesses wrong, and prose about the CLI
 * drifts from the CLI. So there is no second table to keep in step: the tree
 * commander already dispatches against IS the spec, and this walks it. Every
 * path, its aliases, its summary, its usage, its flags (the command's own plus
 * the globals it also accepts), its positional arguments, whether it is hidden,
 * and whether the destructive table (destructiveCommands.ts) marks it.
 *
 * The lazy groups are the catch. They sit in the tree as placeholders until
 * argv names one (commandGroups.ts), so a walk of the default tree would
 * describe `cast browser` as a command with no subcommands and one fake
 * option. `activateAllGroups` is the deliberate exception this verb makes: it
 * loads every group so the dump is complete, and nothing else in the CLI calls
 * it, so an ordinary run still pays for one group at most. ct-49547.
 *
 * Not yet in the guidance catalog: F1's guide seam (ct-49544, snippets.ts) had
 * not landed when this did, so whoever lands it adds `cast agent-context` there.
 */

import type { Command, Option } from "commander";
import { isDestructivePath } from "./destructiveCommands.js";

/** Bumped when the shape below changes in a way a reader must notice. */
export const AGENT_CONTEXT_SCHEMA_VERSION = 1;

export type AgentContextFlag = {
  /** Exactly as declared: "-p, --project <name>". */
  flags: string;
  long?: string;
  short?: string;
  description: string;
  /** boolean takes no value; value requires one; optional-value may take one. */
  type: "boolean" | "value" | "optional-value";
  variadic?: boolean;
  /** A `--no-x` form, which turns its default off. */
  negated?: boolean;
  /** The flag itself must be passed. */
  required?: boolean;
  default?: unknown;
  hidden?: boolean;
  /** Declared on the root, and accepted alongside any command. */
  global?: boolean;
};

export type AgentContextArgument = {
  name: string;
  required: boolean;
  variadic: boolean;
  description?: string;
  default?: unknown;
};

export type AgentContextCommand = {
  /** The path as you would type it: "task ls". */
  command: string;
  path: string[];
  /** Alternate names for this command's own token: ["ws"] for workspace. */
  aliases: string[];
  summary: string;
  /** A runnable line: "cast task ls [options] [query]". */
  usage: string;
  flags: AgentContextFlag[];
  args: AgentContextArgument[];
  /** Registered, but kept out of help. */
  hidden: boolean;
  /** Marked in destructiveCommands.ts: it removes or ends something. */
  destructive: boolean;
  /** Sub-paths, for a group. Empty for a leaf. */
  subcommands: string[];
};

export type AgentContext = {
  schemaVersion: number;
  /** The cast version this surface came from. */
  version: string;
  commandCount: number;
  commands: AgentContextCommand[];
};

/** Commander keeps these off its published types; the walk needs them. */
type CommandInternals = {
  _hidden?: boolean;
  registeredArguments?: Array<{
    name(): string;
    required: boolean;
    variadic: boolean;
    description?: string;
    defaultValue?: unknown;
  }>;
  _getHelpOption?: () => Option | null | undefined;
};

function flagOf(option: Option, global = false): AgentContextFlag {
  const flag: AgentContextFlag = {
    flags: option.flags,
    description: option.description,
    type: option.required ? "value" : option.optional ? "optional-value" : "boolean",
  };
  if (option.long) flag.long = option.long;
  if (option.short) flag.short = option.short;
  if (option.variadic) flag.variadic = true;
  if (option.negate) flag.negated = true;
  if (option.mandatory) flag.required = true;
  if (option.defaultValue !== undefined) flag.default = option.defaultValue;
  if ((option as Option & { hidden?: boolean }).hidden) flag.hidden = true;
  if (global) flag.global = true;
  return flag;
}

function argsOf(cmd: Command): AgentContextArgument[] {
  return ((cmd as Command & CommandInternals).registeredArguments ?? []).map((arg) => {
    const out: AgentContextArgument = { name: arg.name(), required: arg.required, variadic: arg.variadic };
    if (arg.description) out.description = arg.description;
    if (arg.defaultValue !== undefined) out.default = arg.defaultValue;
    return out;
  });
}

/** The options declared on the root, plus `--help`, which every command answers.
 *  Repeated on each command on purpose: a reader of one entry sees the whole
 *  set it accepts, rather than treating `--help` as unsupported. */
function globalFlags(program: Command): AgentContextFlag[] {
  const help = (program as Command & CommandInternals)._getHelpOption?.();
  return [...program.options, ...(help ? [help] : [])].map((option) => flagOf(option, true));
}

function walk(cmd: Command, path: string[], globals: AgentContextFlag[], out: AgentContextCommand[]): void {
  const children = cmd.commands as Command[];
  out.push({
    command: path.join(" "),
    path,
    aliases: cmd.aliases(),
    summary: cmd.description(),
    usage: ["cast", ...path, cmd.usage()].filter(Boolean).join(" "),
    flags: [...cmd.options.map((option) => flagOf(option)), ...globals],
    args: argsOf(cmd),
    hidden: (cmd as Command & CommandInternals)._hidden === true,
    destructive: isDestructivePath(path),
    subcommands: children.map((child) => [...path, child.name()].join(" ")).sort(),
  });
  for (const child of children) walk(child, [...path, child.name()], globals, out);
}

/**
 * The whole tree as one flat, sorted list. Flat because a path is what an agent
 * types, and sorted so two runs of the same binary diff to nothing.
 *
 * Pass a program with every group already activated, or the groups come out as
 * their placeholders.
 */
export function buildAgentContext(program: Command, version: string): AgentContext {
  const globals = globalFlags(program);
  const commands: AgentContextCommand[] = [];
  for (const child of program.commands as Command[]) walk(child, [child.name()], globals, commands);
  commands.sort((a, b) => a.command.localeCompare(b.command));
  return {
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    version,
    commandCount: commands.length,
    commands,
  };
}

/** The default (human) output. The full surface is thousands of lines, so this
 *  reports its size and names the flag that prints it. */
export function formatAgentContextSummary(context: AgentContext): string {
  const destructive = context.commands.filter((cmd) => cmd.destructive).length;
  const groups = context.commands.filter((cmd) => cmd.subcommands.length > 0).length;
  return [
    `cast ${context.version}: ${context.commandCount} commands (${groups} with subcommands, ${destructive} destructive), schema v${context.schemaVersion}.`,
    "Run `cast agent-context --json` for the full machine-readable command surface.",
  ].join("\n");
}
