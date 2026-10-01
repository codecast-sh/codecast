// Shell words as a recorded command line ran them: the scanner every cast
// card uses to read quoted bodies and flags out of a transcript's Bash call.

/**
 * Decode the first shell word in an argument string. Shell words can be made
 * from adjacent quoted and unquoted segments (`'it'\''s ready'`,
 * `"hello "'world'`), so matching only the first quote pair can silently show
 * a truncated message. Unsupported/expanded syntax is marked dynamic; callers
 * must never present that decoded recipe as the payload that actually arrived.
 */
export function scanShellWord(source: string): { body: string; dynamic: boolean; quoted: boolean; end: number } {
  let body = "";
  let dynamic = false;
  let quoted = false;
  let quote: "single" | "double" | null = null;
  // Declared outside the loop so the scan can report where the word ended —
  // tokenizeShellArgs walks a whole arg string one word at a time.
  let i = 0;

  for (; i < source.length; i += 1) {
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
      quoted = true;
      continue;
    }
    if (ch === '"') {
      quote = "double";
      quoted = true;
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
  return { body, dynamic, quoted, end: i };
}

export interface ShellToken {
  value: string;
  dynamic: boolean;
  quoted: boolean;
}

// Split an arg string into the shell words the command actually ran with,
// stopping at a heredoc marker. Everything past `<<` is body text, never argv:
// a report that mentions "-m" in prose is not a --message flag, and scanning it
// as one would quote the wrong sentence back at the reader.
export function tokenizeShellArgs(args: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let rest = args;
  while (rest.length > 0) {
    const ws = rest.match(/^\s+/);
    if (ws) {
      rest = rest.slice(ws[0].length);
      continue;
    }
    if (rest.startsWith("<<")) break;
    const { body, dynamic, quoted, end } = scanShellWord(rest);
    // A word that consumed nothing is an operator (`;`, `|`, `>`): the rest of
    // the line belongs to another command.
    if (end === 0) break;
    tokens.push({ value: body, dynamic, quoted });
    rest = rest.slice(end);
  }
  return tokens;
}
