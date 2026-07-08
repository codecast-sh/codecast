// Pure parsing of `cast ...` shell commands surfaced in the conversation view.
// Kept standalone (no React deps) so it can be unit-tested directly, mirroring
// sessionMessage.ts. ConversationView imports these for its cast-command cards
// (the "Message to" / "read" blocks and the cast task/plan/doc renderers).

// Agents routinely prefix a command with `cd <dir>;` or `cd <dir> &&` to run it
// from the repo root (e.g. `cd /repo; cast send jx7abcd "hi"`). Strip that leading
// prefix so command detection sees the bare command — otherwise a start-anchored
// `^cast` match misses and the command falls back to a raw shell render.
export function stripCdPrefix(cmd: string): string {
  return cmd.replace(/^cd\s+\S+\s*[;&]+\s*/, "");
}

// Unwrap `bash -c '<cmd>'` / `sh -c "<cmd>"` style wrappers down to the inner command.
export function unwrapShellCommand(cmd: string): string {
  const m =
    cmd.match(/^(?:\/bin\/)?(?:ba)?sh\s+-\S+\s+'([^']*)'\s*$/) ||
    cmd.match(/^(?:\/bin\/)?(?:ba)?sh\s+-\S+\s+"([^"]*)"\s*$/) ||
    cmd.match(/^(?:\/bin\/)?(?:ba)?sh\s+-\S+\s+(\S+)\s*$/);
  return m ? m[1] : cmd;
}

export interface ParsedCastCommand {
  category: string;
  subcommand: string;
  args: string;
  fullCmd: string;
}

// Parse a raw shell command into its cast (category, subcommand, args), tolerating
// a `bash -c` wrapper and a leading `cd <dir>;`/`&&` prefix. Returns null when the
// command isn't a `cast ...` invocation.
export function parseCastCommandString(rawCommand: string): ParsedCastCommand | null {
  const cmd = stripCdPrefix(unwrapShellCommand(rawCommand.trim()));
  const match = cmd.match(/^cast\s+(\w[\w-]*)(?:\s+(\w[\w-]*))?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    category: match[1],
    subcommand: match[2] || "",
    args: (match[3] || "").trim(),
    fullCmd: cmd,
  };
}
