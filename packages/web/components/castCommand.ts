// Pure parsing of `cast ...` shell commands surfaced in the conversation view.
// Kept standalone (no React deps) so it can be unit-tested directly, mirroring
// sessionMessage.ts. ConversationView imports these for its cast-command cards
// (the "Message to" / "read" blocks and the cast task/plan/doc renderers).

import { extractBrowserTabId } from "../lib/browserFocus";

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
    const bodyText = bodyLines.join("\n");
    // Unquoted heredocs undergo parameter, command, and arithmetic expansion,
    // but only via `$`, backticks, and backslashes — a body with none of those
    // is delivered byte-for-byte, so an unquoted delimiter alone is no reason
    // to disclaim it. A missing closing delimiter never executed, so don't
    // claim its recorded source was a delivered literal either.
    const expandable = !quotedDelimiter && /[$`\\]/.test(bodyText);
    return {
      body: bodyText,
      kind: foundDelimiter && !expandable ? "heredoc" : "dynamic",
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

// `cast chat reply <message_id> "<text>" [--status error]` and
// `cast chat send "<text>" --channel <id> [--thread <root_id>]` — the two chat
// writes. The transcript renders them as chat bubbles, so this pulls the pieces
// a bubble needs: which placeholder/channel/thread it went to, the text as the
// shell delivered it (or a recipe, flagged `dynamic`), and whether the reply
// declared it could not answer.
export interface ChatSendArgs {
  messageId?: string;
  channelId?: string;
  threadRootId?: string;
  status?: string;
  body: string;
  kind: SendBody["kind"];
}

const FLAG_RE = /^-{1,2}[A-Za-z]/;

export function extractChatSendArgs(subcommand: string, args: string): ChatSendArgs | null {
  if (subcommand !== "reply" && subcommand !== "send") return null;
  const tokens = tokenizeShellArgs(args);
  const positional: ShellToken[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.quoted && FLAG_RE.test(t.value)) {
      // Every chat flag takes a value (--channel/--thread/--status); --json is the
      // one boolean, and its "value" would be the next flag or nothing.
      const next = tokens[i + 1];
      if (t.value !== "--json" && next && !(!next.quoted && FLAG_RE.test(next.value))) i += 1;
      continue;
    }
    positional.push(t);
  }
  const messageId = subcommand === "reply" ? positional.shift()?.value : undefined;

  // The body: a heredoc/stdin `-` anywhere in the args, else the first remaining
  // positional word. extractSendBody already knows every shape a body takes,
  // so hand it the args from the `-` onward.
  const dash = args.match(/(?:^|\s)-(?=\s|$)/);
  let body: SendBody;
  if (dash && dash.index !== undefined) {
    body = extractSendBody(args.slice(dash.index + dash[0].indexOf("-")));
  } else if (positional[0]) {
    body = { body: positional[0].value, kind: positional[0].dynamic ? "dynamic" : "literal" };
  } else {
    body = { body: "", kind: "dynamic" };
  }
  return {
    messageId,
    channelId: extractFlagValue(args, ["--channel"]) ?? undefined,
    threadRootId: extractFlagValue(args, ["--thread"]) ?? undefined,
    status: extractFlagValue(args, ["--status"]) ?? undefined,
    ...body,
  };
}

// `cast state --status done "…"` / `cast state --status blocked - <<'EOF'…` pin
// the thread state the UI already renders expanded above the composer, so the
// row needs only two things: the declared status and the state's first line.
// Rendering the whole body here would show the same text twice.
export interface StateArgs {
  status: string | null;
  /** First non-empty line of the pinned text, or null when the body was
   * shell-expanded (a recipe, not the delivered state). */
  headline: string | null;
}

export function extractStateArgs(args: string): StateArgs {
  const status = extractFlagValue(args, ["--status"]);

  // The body: a heredoc/stdin `-` anywhere in the args, else the first
  // positional word that isn't a flag or a flag's value.
  const dash = args.match(/(?:^|\s)-(?=\s|$)/);
  let body: SendBody;
  if (dash && dash.index !== undefined) {
    body = extractSendBody(args.slice(dash.index + dash[0].indexOf("-")));
  } else {
    const tokens = tokenizeShellArgs(args);
    let positional: ShellToken | undefined;
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (!t.quoted && FLAG_RE.test(t.value)) {
        const next = tokens[i + 1];
        if (next && !(!next.quoted && FLAG_RE.test(next.value))) i += 1;
        continue;
      }
      positional = t;
      break;
    }
    body = positional
      ? { body: positional.value, kind: positional.dynamic ? "dynamic" : "literal" }
      : { body: "", kind: "dynamic" };
  }
  if (body.kind === "dynamic") return { status, headline: null };
  const headline = body.body.split("\n").find((l) => l.trim())?.trim();
  return { status, headline: headline || null };
}

// ── cast decide ─────────────────────────────────────────────────────────────
// `cast decide "<question>" -o … -o … --context - <<'EOF' …` posts a decision;
// `cast decide edit [id] …` changes it; `cast decide cancel [id]` withdraws it;
// `cast decide ls` lists them. The transcript renders the first three as a
// decision card — the same card the queue shows — so the agent never has to
// restate the question in prose. What is parsed here is the recorded argv; the
// live row in the store (status, the answer, an edited text) overrides it when
// the conversation view can find it.
export interface DecideArgs {
  verb: "ask" | "edit" | "cancel" | "ls";
  /** Positional id on edit/cancel, when given. */
  decisionId?: string;
  /** The question (ask positional, or edit --question). Null when absent or shell-expanded. */
  question: string | null;
  options: Array<{ label: string; description?: string }>;
  /** Literal/heredoc context. Null when absent or a recipe (`"$(cat f)"`, piped `-`). */
  context: string | null;
  report?: string;
  advisory: boolean;
  /** 0-based, mirrors the row's default_option. */
  defaultOption?: number;
  /** edit --blocking: an advisory ask made blocking. */
  blocking: boolean;
}

const DECIDE_VERBS: Record<string, DecideArgs["verb"]> = {
  edit: "edit", cancel: "cancel", rm: "cancel", withdraw: "cancel", ls: "ls", list: "ls",
};
const DECIDE_VALUE_FLAGS = new Set(["-o", "--option", "--context", "--report", "--default", "--session", "--question"]);

// Mirrors the CLI's "Label :: what happens if chosen" split (decideCommand.ts).
export function splitDecideOption(raw: string): { label: string; description?: string } {
  const idx = raw.indexOf("::");
  if (idx === -1) return { label: raw.trim() };
  const label = raw.slice(0, idx).trim();
  const description = raw.slice(idx + 2).trim();
  return description ? { label, description } : { label };
}

export function extractDecideArgs(subcommand: string, args: string): DecideArgs {
  // The parser puts a bare first word in the subcommand slot; a quoted
  // question lands in args. Fold a non-verb word back so both shapes parse.
  const verb = DECIDE_VERBS[subcommand];
  const rest = verb ? args : subcommand ? `${subcommand} ${args}`.trim() : args;
  const out: DecideArgs = { verb: verb ?? "ask", question: null, options: [], context: null, advisory: false, blocking: false };
  if (out.verb === "ls") return out;

  const tokens = tokenizeShellArgs(rest);
  const positional: ShellToken[] = [];
  let contextToken: ShellToken | null = null;
  let questionFlag: ShellToken | null = null;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.quoted && FLAG_RE.test(t.value)) {
      if (t.value === "--advisory") { out.advisory = true; continue; }
      if (t.value === "--blocking") { out.blocking = true; continue; }
      if (!DECIDE_VALUE_FLAGS.has(t.value)) continue;
      const next = tokens[i + 1];
      if (!next) continue;
      i += 1;
      if (t.value === "-o" || t.value === "--option") out.options.push(splitDecideOption(next.value));
      else if (t.value === "--context") contextToken = next;
      else if (t.value === "--report") out.report = next.value;
      else if (t.value === "--question") questionFlag = next;
      else if (t.value === "--default") {
        const n = parseInt(next.value, 10);
        if (!isNaN(n)) out.defaultOption = n - 1;
      }
      continue;
    }
    positional.push(t);
  }

  if (out.verb === "ask") {
    const q = positional[0];
    out.question = q && !q.dynamic ? q.value : null;
  } else {
    const id = positional[0];
    if (id && /^[a-z0-9]{20,}$/i.test(id.value)) out.decisionId = id.value;
    out.question = questionFlag && !questionFlag.dynamic ? questionFlag.value : null;
  }

  if (contextToken) {
    if (contextToken.value === "-" && !contextToken.quoted) {
      // `--context -  <<'EOF' …`: the body is the heredoc after the marker.
      const dash = rest.match(/--context\s+(-)(?=\s|$)/);
      const body = dash && dash.index !== undefined ? extractSendBody(rest.slice(dash.index + dash[0].lastIndexOf("-"))) : null;
      out.context = body && body.kind === "heredoc" ? body.body : null;
    } else {
      out.context = contextToken.dynamic ? null : contextToken.value;
    }
  }
  if (!out.advisory) out.defaultOption = undefined;
  return out;
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

  if (CAST_BODY_SUBCOMMANDS.has(subcommand)) {
    for (const { flags, label } of CAST_BODY_FLAGS) push(extractFlagValue(args, flags), label);
  }

  return parts;
}

// `FOO=1 cast …` and `env -u NAME cast …` run cast with a modified environment —
// the command the row describes is still cast (agents lean on this constantly,
// e.g. `CAST_BROWSER_LEGACY=1 cast browser …`). Strip the environment words so
// the start-anchored `^cast` match below still sees the real command.
export function stripEnvPrefix(cmd: string): string {
  const assignment = String.raw`[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S)*`;
  const env = cmd.match(
    new RegExp(String.raw`^env(?:\s+-u\s+[A-Za-z_][A-Za-z0-9_]*|\s+--?[A-Za-z-]+|\s+${assignment})*\s+`),
  );
  const rest = env ? cmd.slice(env[0].length) : cmd;
  const bare = rest.match(new RegExp(String.raw`^(?:${assignment}\s+)+`));
  return bare ? rest.slice(bare[0].length) : rest;
}

// Parse a raw shell command into its cast (category, subcommand, args), tolerating
// a `bash -c` wrapper, a leading `cd <dir>;`/`&&` prefix, and leading environment
// words (`FOO=1 …`, `env -u NAME …`). Returns null when the command isn't a
// `cast ...` invocation.
export function parseCastCommandString(rawCommand: string): ParsedCastCommand | null {
  const cmd = stripEnvPrefix(stripCdPrefix(unwrapShellCommand(rawCommand.trim())));
  const match = cmd.match(/^cast\s+(\w[\w-]*)(?:\s+(\w[\w-]*))?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    category: match[1],
    subcommand: match[2] || "",
    args: (match[3] || "").trim(),
    fullCmd: cmd,
  };
}

// ── cast browser page URLs ──────────────────────────────────────────────────
// `cast browser` drives one stateful page per agent, but only some verbs print
// where it is: open/snapshot/reload/back/forward emit the page URL line, and a
// click that navigates reports the destination. Everything else (find, type,
// shot, press, scroll) prints no URL at all. The row's "open tab" link
// therefore comes in two steps: extract a URL from the row itself when its
// output has one, and otherwise CARRY the last known URL forward — the browser
// is still on that page, the row just didn't restate it.

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** URL stated by this row itself, or null. Mirrors the CLI's output shapes. */
export function extractBrowserPageUrl(subcommand: string, args: string, output: string): string | null {
  const lines = [...output.replace(ANSI_RE, "").matchAll(/^\s*(https?:\/\/\S+)\s*$/gm)];
  if (lines.length > 0) return lines[lines.length - 1][1];
  if (subcommand === "open") {
    const m = args.match(/^"([^"]*)"/) || args.match(/^'([^']*)'/) || args.match(/^(\S+)/);
    const firstArg = m ? m[1] : "";
    if (firstArg && firstArg !== "-" && firstArg !== "back" && firstArg !== "forward") {
      if (/^https?:\/\//i.test(firstArg)) return firstArg;
      if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(firstArg)) return `https://${firstArg}`;
    }
  }
  return null;
}

export interface BrowserRowInput {
  toolCallId: string;
  subcommand: string;
  args: string;
  output: string;
}

/** What a `cast browser` row was acting on: the page, and the driven tab. */
export interface BrowserRowState {
  url?: string;
  tabId?: string;
}

/**
 * Walk a conversation's browser rows in order and give every row the page URL
 * and tab id it was on: its own when the output states them, else the last
 * ones any earlier row established. Only tab-affecting verbs print the tab
 * footer (cli tabFooter.ts), so a `shot` or `find` row inherits the tab of the
 * `open`/`click` before it. An `open` row's own URL wins over the carried one —
 * it IS the navigation.
 */
export function buildBrowserRowMap(rows: BrowserRowInput[]): Record<string, BrowserRowState> {
  const map: Record<string, BrowserRowState> = {};
  let url: string | null = null;
  let tabId: string | null = null;
  for (const row of rows) {
    url = extractBrowserPageUrl(row.subcommand, row.args, row.output) ?? url;
    tabId = extractBrowserTabId(row.output) ?? tabId;
    if (url || tabId) map[row.toolCallId] = { ...(url && { url }), ...(tabId && { tabId }) };
  }
  return map;
}

export function sameBrowserRowMap(a: Record<string, BrowserRowState>, b: Record<string, BrowserRowState>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => b[k] && a[k].url === b[k].url && a[k].tabId === b[k].tabId);
}

// ── cast browser do — the CLI's batch ───────────────────────────────────────
// `cast browser do "open x" "find Sign in" click` (or `do -` with one step per
// heredoc line) is the CLI's answer to the extension's browser_batch, so the
// row renders the same way: one line per step with what that step reported.
// Steps come from the recorded argv; outcomes come from the CLI's own output.

/** A batch step as it renders: the verb, the rest of the step, and its outcome. */
export interface BrowserDoStep {
  verb: string;
  args: string;
}

const BROWSER_DO_VALUE_FLAGS = new Set(["--tab"]);

export function extractBrowserDoSteps(args: string): BrowserDoStep[] {
  const t = args.trim();
  let raw: string[];
  if (/^-(?:\s|$)/.test(t)) {
    const { body, kind } = extractSendBody(t);
    if (kind !== "heredoc") return [];
    raw = body.split("\n");
  } else {
    const tokens = tokenizeShellArgs(t);
    raw = [];
    for (let i = 0; i < tokens.length; i++) {
      const v = tokens[i].value;
      if (!tokens[i].quoted && v.startsWith("--")) {
        if (BROWSER_DO_VALUE_FLAGS.has(v)) i++;
        continue;
      }
      raw.push(v);
    }
  }
  return raw
    .map((s) => s.trim())
    .filter(Boolean)
    .map((step) => {
      const m = step.match(/^(\S+)\s*([\s\S]*)$/);
      return { verb: m ? m[1] : step, args: m ? m[2] : "" };
    });
}

/**
 * Per-step outcomes from a `cast browser do` output, aligned by index with
 * extractBrowserDoSteps. Two CLI generations print a flow:
 *
 *   engine (current)            legacy
 *   › open example.com          ● open example.com
 *   ✓ Example Domain                Example Domain — https://example.com/
 *     https://example.com/      ○ click
 *   › click                         element is covered
 *   x element is covered
 *
 * The engine names each step on a `›` line and gives the verdict on the next
 * glyph line; legacy carries the verdict in the header glyph. Both end with a
 * footer (page URL, `tab …`, "N steps in …") that belongs to no step. Steps
 * the CLI never reached (it stops at the first failure) stay without a verdict.
 */
const DO_OK_GLYPH = /^[●*✓✔]\s?(.*)$/;
const DO_BAD_GLYPH = /^[○x✗✘×]\s(.*)$/;
const DO_FOOTER_LINE = /^\s*(?:\d+\/?\d* steps? in .*|tab [0-9A-Za-z:_-]+|https?:\/\/\S+|! .*)$/;

export function splitBrowserDoOutput(output: string, stepCount: number): Array<{ output: string; ok?: boolean }> {
  const outcomes: Array<{ output: string; ok?: boolean }> = Array.from({ length: stepCount }, () => ({ output: "" }));
  const lines = output.replace(ANSI_RE, "").replace(/\r/g, "").split("\n");
  // Drop the trailing footer: everything after the last step's own lines that
  // is a URL, tab id, warning, or the timing line.
  let end = lines.length;
  while (end > 0 && (!lines[end - 1].trim() || DO_FOOTER_LINE.test(lines[end - 1]))) end--;
  const body = lines.slice(0, end);
  const engine = body.some((l) => /^›\s/.test(l));
  const append = (i: number, text: string) => {
    const t = text.trim();
    if (!t) return;
    const o = outcomes[i];
    o.output = o.output ? `${o.output}\n${t}` : t;
  };
  let current = -1;
  for (const line of body) {
    if (engine) {
      const head = line.match(/^›\s(.*)$/);
      if (head) {
        current++;
        if (current >= stepCount) break;
        outcomes[current] = { output: "", ok: true };
        continue;
      }
      if (current < 0 || current >= stepCount) continue;
      const bad = line.match(DO_BAD_GLYPH);
      const good = bad ? null : line.match(DO_OK_GLYPH);
      if (bad) { outcomes[current].ok = false; append(current, bad[1]); }
      else if (good) append(current, good[1]);
      else append(current, line);
      continue;
    }
    const good = line.match(DO_OK_GLYPH);
    const bad = good ? null : line.match(DO_BAD_GLYPH);
    if (good || bad) {
      current++;
      if (current >= stepCount) break;
      outcomes[current] = { output: "", ok: !!good };
      continue;
    }
    if (current < 0 || current >= stepCount) continue;
    if (/^\s/.test(line)) append(current, line);
  }
  return outcomes;
}
