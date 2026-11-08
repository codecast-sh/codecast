// Help for a command that takes its verb as a positional (`cast decide edit`,
// `cast publish video`): commander knows only the one command, so `cast decide
// edit --help` printed the parent's whole help, every flag of every verb. With
// a spec per verb, `--help` after a known verb prints that verb's usage, what
// it does, and only the flags it reads.
import type { Command, HelpContext, Option } from "commander";

export type VerbHelpSpec = {
  /** The usage line, without "Usage: ". */
  usage: string;
  /** What the verb does, one line. */
  summary: string;
  /** Long flag names the verb reads (`--note`), in the order to list them. */
  flags?: readonly string[];
  /** Printed instead of the flags, for a verb that prints a guide of its own. */
  note?: string;
};

/** The help text for one verb, built from the command's own option definitions. */
export function renderVerbHelp(cmd: Command, verb: string, spec: VerbHelpSpec, width = process.stdout.columns || 80): string {
  const help = cmd.createHelp();
  const byLong = new Map((cmd.options as Option[]).map((o) => [o.long, o]));
  const options = (spec.flags ?? []).map((flag) => byLong.get(flag)).filter((o): o is Option => !!o);
  const terms = options.map((o) => help.optionTerm(o));
  const pad = Math.max(0, ...terms.map((t) => t.length));
  const lines = [`Usage: ${spec.usage}`, "", spec.summary];
  if (options.length) {
    lines.push("", "Options:");
    options.forEach((o, i) => {
      const row = `${terms[i]!.padEnd(pad)}  ${help.optionDescription(o)}`;
      lines.push(help.wrap(`  ${row}`, width, pad + 4));
    });
  }
  if (spec.note) lines.push("", spec.note);
  const path: string[] = [];
  for (let at: Command | null = cmd; at; at = at.parent) path.unshift(at.name());
  lines.push("", `Every verb and flag: ${path.join(" ")} --help`);
  return lines.join("\n") + "\n";
}

/** Make `--help` after one of `verbs` print that verb's help; anything else keeps the command's own. */
export function addVerbHelp(cmd: Command, verbs: Readonly<Record<string, VerbHelpSpec>>): Command {
  const own = cmd.helpInformation.bind(cmd);
  // commander sets `args` to the operands before it answers --help, so the verb is already known here.
  cmd.helpInformation = function helpInformation(this: Command, context?: HelpContext): string {
    const verb = this.args?.[0];
    const spec = verb !== undefined && Object.hasOwn(verbs, verb) ? verbs[verb] : undefined;
    return spec ? renderVerbHelp(this, verb!, spec) : own(context);
  };
  return cmd;
}
