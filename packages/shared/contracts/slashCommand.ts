// A slash command reaches a transcript in a different shape than it was typed.
// The composer and a pending row hold "/mcp" or "/model opus"; Claude Code
// records the invocation as "<command-name>/mcp</command-name>
// <command-message>mcp</command-message><command-args></command-args>", and
// only once the command finishes (a panel command such as /mcp writes nothing
// until its panel closes). Comparing the two as text never matches, so every
// matcher between a send and its echo reads both through this.

export type SlashCommand = { name: string; args: string };

// Recognizes both shapes; null for anything that is not a slash command.
export function parseSlashCommand(raw: string): SlashCommand | null {
  const text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<task-reminder>[\s\S]*?<\/task-reminder>/g, "")
    .trim();
  const tagged = text.match(/<command-name>([^<]*)<\/command-name>/) ?? text.match(/<command-message>([^<]*)<\/command-message>/);
  if (tagged) {
    const name = tagged[1].replace(/^\//, "").trim();
    return name ? { name, args: (text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? "").trim() } : null;
  }
  const typed = text.match(/^\/([A-Za-z][\w:.-]*)(?:\s+([\s\S]*))?$/);
  return typed ? { name: typed[1], args: (typed[2] ?? "").trim() } : null;
}

// "/name args" with whitespace flattened, the form both shapes share; null when
// the text is not a slash command.
export function canonicalSlashCommand(raw: string): string | null {
  const command = parseSlashCommand(raw);
  if (!command) return null;
  const args = command.args.replace(/\s+/g, " ").trim();
  return `/${command.name}${args ? ` ${args}` : ""}`;
}
