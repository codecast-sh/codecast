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

/**
 * Decode the first shell word in an argument string. Shell words can be made
 * from adjacent quoted and unquoted segments (`'it'\''s ready'`,
 * `"hello "'world'`), so matching only the first quote pair can silently show
 * a truncated message. Unsupported/expanded syntax is marked dynamic; callers
 * must never present that decoded recipe as the payload that actually arrived.
 */
function scanShellWord(source: string): { body: string; dynamic: boolean } {
  let body = "";
  let dynamic = false;
  let quote: "single" | "double" | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (quote === "single") {
      if (ch === "'") quote = null;
      else body += ch;
      continue;
    }

    if (quote === "double") {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\") {
        const next = source[i + 1];
        if (next === undefined) {
          body += "\\";
          dynamic = true;
          continue;
        }
        if (next === "\n") {
          i += 1;
          continue;
        }
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          body += next;
          i += 1;
          continue;
        }
        body += `\\${next}`;
        i += 1;
        continue;
      }
      if (ch === "$" || ch === "`") dynamic = true;
      body += ch;
      continue;
    }

    if (/\s/.test(ch)) break;
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) {
        body += "\\";
        dynamic = true;
      } else if (next === "\n") {
        i += 1;
      } else {
        body += next;
        i += 1;
      }
      continue;
    }

    // An unquoted shell operator terminates the word: everything scanned so
    // far IS the argv the shell delivered, and the rest is a separate command
    // (`"msg"; cast disown …`), a pipe, or a redirect. Don't let a trailing
    // chained command poison a fully literal message into "dynamic". An
    // operator with no word before it means the body came from elsewhere.
    if (/[;&|<>()]/.test(ch)) {
      if (body.length === 0) dynamic = true;
      break;
    }

    // These constructs are expanded by the shell within the word. Keep the
    // visible recipe, but never call it the delivered body.
    if (
      ch === "$" ||
      ch === "`" ||
      ch === "*" ||
      ch === "?" ||
      ch === "[" ||
      ch === "{" ||
      (ch === "~" && body.length === 0)
    ) {
      dynamic = true;
    }
    body += ch;
  }

  if (quote !== null) dynamic = true;
  return { body, dynamic };
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

  // Heredoc: `- <<'EOF'\n…\nEOF` (also <<EOF, <<-EOF, << 'EOF', flags between).
  const hd = /^-(?:\s|$)/.test(t)
    ? t.match(
        /<<(-?)\s*(?:'([^'\n]+)'|"([^"\\\n]+)"|([A-Za-z0-9_.-]+))[^\n]*\n([\s\S]*)$/,
      )
    : null;
  if (hd) {
    const tag = hd[2] || hd[3] || hd[4];
    const stripTabs = hd[1] === "-";
    const quotedDelimiter = Boolean(hd[2] || hd[3]);
    const bodyLines: string[] = [];
    let foundDelimiter = false;
    for (const line of hd[5].split("\n")) {
      const probe = stripTabs ? line.replace(/^\t+/, "") : line;
      if (probe === tag) {
        foundDelimiter = true;
        break;
      }
      bodyLines.push(probe);
    }
    return {
      body: bodyLines.join("\n"),
      // Unquoted heredocs undergo parameter, command, and arithmetic expansion.
      // A missing closing delimiter never executed, so don't claim its recorded
      // source was a delivered literal either.
      kind: quotedDelimiter && foundDelimiter ? "heredoc" : "dynamic",
    };
  }

  // Bare `-`: body came from a pipe or `< file` — not recorded in the command.
  if (/^-(\s|$)/.test(t)) return { body: t, kind: "dynamic" };

  const { body, dynamic } = scanShellWord(t);
  return { body: body || t, kind: dynamic ? "dynamic" : "literal" };
}

// Pull the value of an inline message flag (`-m "…"` / `--message '…'`) out of a
// cast command's arg string, e.g. `cast task done ct-1 -m "verified in prod"`.
// Only literal quoted/bare values are returned — an expanded value ($VAR, $(…))
// is a recipe, not the delivered text, so it yields null.
export function extractMessageFlag(args: string): string | null {
  const m = args.match(/(?:^|\s)(?:-m|--message)\s+([\s\S]+)/);
  if (!m) return null;
  const { body, dynamic } = scanShellWord(m[1]);
  return !dynamic && body ? body : null;
}

// The body argument of `cast task comment <id> "…"` / `cast plan comment <id> -`:
// everything after the leading entity id (short id, or a bare Convex id for
// docs), decoded like a send body (quoted word or heredoc). Returns null when
// the id is missing or the body was shell-expanded.
export function extractCommentBody(args: string): string | null {
  const rest = args.replace(/^(?:(?:ct|pl)-[a-z0-9]+|[a-z0-9]{20,})\s+/i, "");
  if (rest === args) return null;
  const { body, kind } = extractSendBody(rest);
  return kind === "dynamic" ? null : body || null;
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
