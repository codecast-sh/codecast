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
function scanShellWord(source: string): { body: string; dynamic: boolean; quoted: boolean; end: number } {
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

// The value of a flag (`-m "…"`, `--goal '…'`) in a cast command's args. Reads
// the tokenized argv rather than the raw string, so a flag spelled inside a
// quoted body or a heredoc can't be mistaken for one. An expanded value ($VAR,
// $(…)) is a recipe, not the delivered text, so it yields null.
export function extractFlagValue(args: string, flags: string[]): string | null {
  const tokens = tokenizeShellArgs(args);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i].dynamic || !flags.includes(tokens[i].value)) continue;
    const value = tokens[i + 1];
    // A bare `-x` after the flag is the NEXT flag, not this one's value: several
    // cast flags are booleans (`cast plan comment pl-88 "…" -d -r "why"`).
    if (!value.quoted && /^-{1,2}[A-Za-z]/.test(value.value)) return null;
    return !value.dynamic && value.value ? value.value : null;
  }
  return null;
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
  return extractFlagValue(args, ["-m", "--message"]);
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

// "t"/"p"/"d" are the short spellings, "sched"/"schedule" the pre-rename name of
// `cast trigger` — old transcripts replay them forever, so every reader resolves
// a category through here and sees one name per object kind.
const CAST_CATEGORY_ALIASES: Record<string, string> = {
  t: "task",
  p: "plan",
  d: "doc",
  sched: "trigger",
  schedule: "trigger",
};

export function normalizeCastCategory(category: string): string {
  return CAST_CATEGORY_ALIASES[category] || category;
}

export interface CastBodyPart {
  label?: string;
  text: string;
}

// Flags whose value is prose the person wrote, not a switch. Order is the order
// they read in: a plan's goal before its body.
const CAST_BODY_FLAGS: Array<{ flags: string[]; label?: string }> = [
  { flags: ["-g", "--goal"], label: "goal" },
  { flags: ["-b", "--body"] },
  { flags: ["-c", "--content"] },
  { flags: ["-d", "--description"] },
  { flags: ["-m", "--message"] },
  { flags: ["--summary"] },
  { flags: ["-r", "--reason"], label: "why" },
];

// Only mutations carry prose. Reading flags off queries would quote a filter
// back as content (`cast feed -m samvit` names a teammate, not a message).
const CAST_BODY_SUBCOMMANDS = new Set([
  "comment", "create", "add", "done", "drop", "complete",
  "edit", "update", "decide", "discover", "note",
]);

// The prose a cast mutation carried: a comment body, a done note, a plan's goal,
// a trigger's prompt, a pinned thread state. This is the content of the action —
// the conversation renders it as a message body, so one function decides what
// that content is for every cast command instead of each card guessing.
export function extractCastBodyParts(
  category: string,
  subcommand: string,
  args: string,
): CastBodyPart[] {
  const cat = normalizeCastCategory(category);
  const parts: CastBodyPart[] = [];
  const push = (text: string | null, label?: string) => {
    const trimmed = text?.trim();
    if (trimmed && !parts.some((p) => p.text === trimmed)) parts.push({ text: trimmed, label });
  };

  // Commands whose prose is the first positional argument.
  const positional = () => {
    const { body, kind } = extractSendBody(args);
    return kind === "dynamic" ? null : body || null;
  };

  if (subcommand === "comment") push(extractCommentBody(args));
  else if (cat === "trigger" && subcommand === "add") push(positional(), "prompt");
  else if (cat === "state" && !["clear", "show"].includes(subcommand)) push(positional());

  if (CAST_BODY_SUBCOMMANDS.has(subcommand)) {
    for (const { flags, label } of CAST_BODY_FLAGS) push(extractFlagValue(args, flags), label);
  }

  return parts;
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
