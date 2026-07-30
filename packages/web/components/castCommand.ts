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

export interface SendBody {
  body: string;
  kind: "literal" | "heredoc" | "dynamic";
}

// Pull the message body out of a `cast send <id> …` arg string. The transcript
// records the command AS TYPED, so what the args contain falls into three shapes:
//   literal — a quoted string with no shell expansion: the recorded text IS the
//             delivered message.
//   heredoc — `- <<'EOF' … EOF`: the delivered body is recorded verbatim in the
//             heredoc; extract it.
//   dynamic — `"$(cat f)"`, backticks, `$VAR`, or a bare `-` fed by a pipe or
//             `< file` redirect: the shell computed the real payload before cast
//             ran, so the recorded text is a recipe, NOT the delivered message.
//             Callers must not present it as the message body.
export function extractSendBody(args: string): SendBody {
  const t = args.trim();

  // Quoted bodies first — a literal message may itself contain "<<EOF" text, and
  // a genuine heredoc invocation never starts with a quote (it starts with `-`).
  const dq = t.match(/^"((?:[^"\\]|\\.)*)"/);
  if (dq) {
    const body = dq[1].replace(/\\"/g, '"');
    // Inside double quotes the shell expands $… and `…` before cast sees them.
    return { body, kind: /(^|[^\\])[$`]/.test(dq[1]) ? "dynamic" : "literal" };
  }
  const sq = t.match(/^'((?:[^'\\]|\\.)*)'/);
  if (sq) return { body: sq[1].replace(/\\'/g, "'"), kind: "literal" };

  // Heredoc: `- <<'EOF'\n…\nEOF` (also <<EOF, <<-EOF, << 'EOF', flags between).
  const hd = t.match(/<<(-?)\s*(?:'(\w+)'|"(\w+)"|(\w+))[^\n]*\n([\s\S]*)$/);
  if (hd) {
    const tag = hd[2] || hd[3] || hd[4];
    const stripTabs = hd[1] === "-";
    const bodyLines: string[] = [];
    for (const line of hd[5].split("\n")) {
      const probe = stripTabs ? line.replace(/^\t+/, "") : line;
      if (probe === tag) break;
      bodyLines.push(probe);
    }
    return { body: bodyLines.join("\n").trim(), kind: "heredoc" };
  }

  // Bare `-`: body came from a pipe or `< file` — not recorded in the command.
  if (/^-(\s|$)/.test(t)) return { body: t, kind: "dynamic" };

  // Unquoted body: drop any trailing --flags so they don't render as message text.
  const bare = t.replace(/\s+--\w[\s\S]*$/, "").trim() || t;
  return { body: bare, kind: /[$`]/.test(bare) ? "dynamic" : "literal" };
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
