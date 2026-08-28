import { test, expect, describe } from "bun:test";
import { stripCdPrefix, stripEnvPrefix, unwrapShellCommand, parseCastCommandString, extractSendBody, extractCommentBody, extractMessageFlag, extractFlagValue, extractCastBodyParts, normalizeCastCategory, extractBrowserPageUrl, buildBrowserRowMap, extractBrowserDoSteps, splitBrowserDoOutput, extractChatSendArgs, extractStateArgs, extractDecideArgs } from "./castCommand";

describe("stripEnvPrefix", () => {
  test("strips a leading assignment", () => {
    expect(stripEnvPrefix('CAST_BROWSER_LEGACY=1 cast browser open example.com')).toBe(
      "cast browser open example.com",
    );
  });

  test("strips several assignments, including quoted values", () => {
    expect(stripEnvPrefix('FOO=1 BAR="a b" cast task ready')).toBe("cast task ready");
  });

  test("strips an `env` prefix with -u flags and assignments", () => {
    expect(stripEnvPrefix("env -u CLAUDECODE FOO=1 cast send jx7a6xc hi")).toBe(
      "cast send jx7a6xc hi",
    );
  });

  test("leaves a command with no env words untouched", () => {
    expect(stripEnvPrefix('cast send jx7a6xc "hi"')).toBe('cast send jx7a6xc "hi"');
  });

  test("does not eat an assignment-looking word past the command start", () => {
    expect(stripEnvPrefix("cast config browser_capture=off")).toBe(
      "cast config browser_capture=off",
    );
  });
});

describe("parseCastCommandString with env prefixes", () => {
  test("an env-prefixed cast browser command still parses as a cast row", () => {
    const parsed = parseCastCommandString("CAST_BROWSER_LEGACY=1 cast browser open example.com");
    expect(parsed?.category).toBe("browser");
    expect(parsed?.subcommand).toBe("open");
  });

  test("cd prefix and env prefix compose", () => {
    const parsed = parseCastCommandString("cd /repo && FOO=1 cast task ready");
    expect(parsed?.category).toBe("task");
  });

  test("an env-prefixed non-cast command stays null", () => {
    expect(parseCastCommandString("FOO=1 ls -la")).toBeNull();
  });
});

describe("stripCdPrefix", () => {
  test("strips a leading `cd <dir>;` prefix", () => {
    expect(stripCdPrefix("cd /Users/ashot/src/codecast; cast send jx7a6xc \"hi\"")).toBe(
      "cast send jx7a6xc \"hi\"",
    );
  });

  test("strips a leading `cd <dir> &&` prefix", () => {
    expect(stripCdPrefix("cd /repo && cast task ready")).toBe("cast task ready");
  });

  test("leaves a command with no cd prefix untouched", () => {
    expect(stripCdPrefix("cast send jx7a6xc \"hi\"")).toBe("cast send jx7a6xc \"hi\"");
  });

  test("does not strip a `cd` that isn't a leading prefixed command", () => {
    // No `;`/`&&` separator — not a prefix, so leave it alone.
    expect(stripCdPrefix("cast doc create \"cd into the dir\"")).toBe('cast doc create "cd into the dir"');
  });
});

describe("parseCastCommandString", () => {
  test("parses a bare `cast send`", () => {
    expect(parseCastCommandString('cast send jx7a6xc "coordinating on the header"')).toEqual({
      category: "send",
      subcommand: "jx7a6xc",
      args: '"coordinating on the header"',
      fullCmd: 'cast send jx7a6xc "coordinating on the header"',
    });
  });

  test("parses through a leading `cd <dir>;` prefix (the outbound-card regression)", () => {
    // Agents prefix `cast send` with a cd into the repo; the card must still render.
    const raw = 'cd /Users/ashot/src/codecast; cast send jx7a6xc "Coordinating on the header"';
    expect(parseCastCommandString(raw)).toEqual({
      category: "send",
      subcommand: "jx7a6xc",
      args: '"Coordinating on the header"',
      fullCmd: 'cast send jx7a6xc "Coordinating on the header"',
    });
  });

  test("parses through a leading `cd <dir> &&` prefix", () => {
    const r = parseCastCommandString('cd /repo && cast read jx70ntf 12:20');
    expect(r).toEqual({ category: "read", subcommand: "jx70ntf", args: "12:20", fullCmd: "cast read jx70ntf 12:20" });
  });

  test("parses through a `bash -c` wrapper", () => {
    const r = parseCastCommandString(`bash -c 'cast task done ct-123'`);
    expect(r).toEqual({ category: "task", subcommand: "done", args: "ct-123", fullCmd: "cast task done ct-123" });
  });

  test("parses through a `bash -c` wrapper with an inner cd prefix", () => {
    const r = parseCastCommandString(`bash -c "cd /repo; cast plan show pl-77"`);
    expect(r).toEqual({ category: "plan", subcommand: "show", args: "pl-77", fullCmd: "cast plan show pl-77" });
  });

  test("returns null for a non-cast command", () => {
    expect(parseCastCommandString("cd /repo; npm run build")).toBeNull();
    expect(parseCastCommandString("git status")).toBeNull();
    expect(parseCastCommandString("")).toBeNull();
  });

  test("does not treat `castle` as `cast` (word boundary)", () => {
    expect(parseCastCommandString("castle build")).toBeNull();
  });
});

describe("extractSendBody", () => {
  test("double-quoted literal", () => {
    expect(extractSendBody('"take the auth half"')).toEqual({ body: "take the auth half", kind: "literal" });
  });

  test("double-quoted literal with escaped quotes and trailing flag", () => {
    expect(extractSendBody('"say \\"done\\"" --from jx7abcd')).toEqual({ body: 'say "done"', kind: "literal" });
  });

  test("single-quoted body is always literal, even with $ inside", () => {
    expect(extractSendBody("'costs $(a lot)'")).toEqual({ body: "costs $(a lot)", kind: "literal" });
  });

  test("decodes adjacent shell segments instead of truncating the delivered word", () => {
    expect(extractSendBody(String.raw`'it'\''s ready'`)).toEqual({
      body: "it's ready",
      kind: "literal",
    });
    expect(extractSendBody(`"hello "'world' --from jx7abcd`)).toEqual({
      body: "hello world",
      kind: "literal",
    });
  });

  test("decodes escaped characters in an unquoted shell word", () => {
    expect(extractSendBody(String.raw`hello\ world --from jx7abcd`)).toEqual({
      body: "hello world",
      kind: "literal",
    });
  });

  test("command substitution in double quotes is dynamic", () => {
    const result = extractSendBody('"$(cat reply.md)"');
    expect(result.kind).toBe("dynamic");
    expect(result.body).toBe("$(cat reply.md)");
  });

  test("variable expansion in double quotes is dynamic", () => {
    expect(extractSendBody('"done: $RESULT"').kind).toBe("dynamic");
  });

  test("escaped dollar in double quotes stays literal", () => {
    expect(extractSendBody('"costs \\$5"')).toEqual({ body: "costs $5", kind: "literal" });
  });

  test("double-quote backslash parity matches shell expansion", () => {
    expect(extractSendBody('"path \\\\$HOME"')).toEqual({
      body: "path \\$HOME",
      kind: "dynamic",
    });
    expect(extractSendBody('"path \\\\\\$HOME"')).toEqual({
      body: "path \\$HOME",
      kind: "literal",
    });
  });

  test("escaped and unescaped backticks follow shell expansion rules", () => {
    expect(extractSendBody('"run \\`safe\\`"')).toEqual({
      body: "run `safe`",
      kind: "literal",
    });
    expect(extractSendBody('"run \\\\`whoami`"')).toEqual({
      body: "run \\`whoami`",
      kind: "dynamic",
    });
  });

  test("double quotes consume escaped slashes but preserve backslash-n", () => {
    expect(extractSendBody('"C:\\\\tmp says \\n"')).toEqual({
      body: "C:\\tmp says \\n",
      kind: "literal",
    });
  });

  test("heredoc body is extracted verbatim", () => {
    const args = "- <<'EOF'\n# Briefing\n\n- item one\n- item two\nEOF";
    expect(extractSendBody(args)).toEqual({ body: "# Briefing\n\n- item one\n- item two", kind: "heredoc" });
  });

  test("unquoted tag with nothing the shell would expand is still a literal delivery", () => {
    const args = "- --from jx7abcd <<EOF\nhello\nthere\nEOF";
    expect(extractSendBody(args)).toEqual({ body: "hello\nthere", kind: "heredoc" });
  });

  test("<<- heredoc strips leading tabs", () => {
    const args = "- <<-'EOF'\n\tindented\n\tlines\n\tEOF";
    expect(extractSendBody(args)).toEqual({ body: "indented\nlines", kind: "heredoc" });
  });

  test("quoted heredoc preserves leading indentation and trailing blank lines", () => {
    const args = "- <<'EOF'\n    const answer = 42;\n\n\nEOF";
    expect(extractSendBody(args)).toEqual({
      body: "    const answer = 42;\n\n",
      kind: "heredoc",
    });
  });

  test("quoted heredoc delimiters may contain punctuation or spaces", () => {
    expect(extractSendBody("- <<'END-MESSAGE'\nbody\nEND-MESSAGE")).toEqual({
      body: "body",
      kind: "heredoc",
    });
    expect(extractSendBody("- <<'END MESSAGE'\nbody\nEND MESSAGE")).toEqual({
      body: "body",
      kind: "heredoc",
    });
  });

  test("an unterminated heredoc is never presented as delivered literal content", () => {
    expect(extractSendBody("- <<'EOF'\nbody").kind).toBe("dynamic");
  });

  test("unquoted heredocs with variables or substitutions never claim literal delivery", () => {
    expect(extractSendBody("- <<EOF\n$HOME\nEOF").kind).toBe("dynamic");
    expect(extractSendBody("- <<EOF\n$(cat reply.md)\nEOF").kind).toBe("dynamic");
    expect(extractSendBody("- <<EOF\nran `date`\nEOF").kind).toBe("dynamic");
    // Backslashes are also rewritten by unquoted-heredoc expansion (\$ → $,
    // \<newline> joins lines), so their presence forfeits the literal claim.
    expect(extractSendBody("- <<EOF\ncost is \\$5\nEOF").kind).toBe("dynamic");
  });

  test("a quoted delimiter keeps literal delivery even when the body has expansion characters", () => {
    expect(extractSendBody("- <<'EOF'\necho $HOME and `date`\nEOF")).toEqual({
      body: "echo $HOME and `date`",
      kind: "heredoc",
    });
  });

  test("an unterminated unquoted heredoc is dynamic even with a plain body", () => {
    expect(extractSendBody("- <<EOF\nplain body").kind).toBe("dynamic");
  });

  test("a quoted message that merely mentions <<EOF is not a heredoc", () => {
    const args = '"see the heredoc form: <<EOF\nfoo"';
    expect(extractSendBody(args)).toEqual({ body: "see the heredoc form: <<EOF\nfoo", kind: "literal" });
  });

  test("bare - (piped/redirected stdin) is dynamic", () => {
    expect(extractSendBody("- < notes.md").kind).toBe("dynamic");
    expect(extractSendBody("-").kind).toBe("dynamic");
  });

  test("unquoted body drops trailing flags", () => {
    expect(extractSendBody("done --from jx7abcd")).toEqual({ body: "done", kind: "literal" });
  });

  test("a chained command after the closing quote does not poison a literal send", () => {
    // Real-world shape: `cast send <id> "…"; cast disown <id> 2>/dev/null | tail -1`
    expect(extractSendBody('"Nothing from me blocks it."; cast disown jx7av85 2>/dev/null | tail -1')).toEqual({
      body: "Nothing from me blocks it.",
      kind: "literal",
    });
    expect(extractSendBody('"ship it"|tail -1')).toEqual({ body: "ship it", kind: "literal" });
    expect(extractSendBody('"ship it">/dev/null')).toEqual({ body: "ship it", kind: "literal" });
    expect(extractSendBody("done;echo ok")).toEqual({ body: "done", kind: "literal" });
  });

  test("expansion inside the word stays dynamic even with a trailing chain", () => {
    expect(extractSendBody('"$(cat reply.md)"; echo sent').kind).toBe("dynamic");
  });

  test("an operator with no word before it never claims literal delivery", () => {
    expect(extractSendBody("< notes.md").kind).toBe("dynamic");
  });

  test("full pipeline: heredoc send parses through parseCastCommandString", () => {
    const raw = "cast send jx7c6zk - <<'EOF'\nline one\nline two\nEOF";
    const parsed = parseCastCommandString(raw)!;
    expect(parsed.category).toBe("send");
    expect(parsed.subcommand).toBe("jx7c6zk");
    expect(extractSendBody(parsed.args)).toEqual({ body: "line one\nline two", kind: "heredoc" });
  });
});

describe("unwrapShellCommand", () => {
  test("unwraps single- and double-quoted bash -c", () => {
    expect(unwrapShellCommand(`bash -c 'cast feed'`)).toBe("cast feed");
    expect(unwrapShellCommand(`/bin/sh -c "cast sessions"`)).toBe("cast sessions");
  });

  test("returns the command unchanged when not wrapped", () => {
    expect(unwrapShellCommand("cast send jx7a6xc hi")).toBe("cast send jx7a6xc hi");
  });
});

describe("extractCommentBody", () => {
  test("quoted body after a task short id", () => {
    expect(extractCommentBody('ct-40882 "wired the parser, deploying next" -t progress')).toBe(
      "wired the parser, deploying next",
    );
  });

  test("heredoc body after a plan short id", () => {
    expect(extractCommentBody("pl-88 - <<'EOF'\nline one\nline two\nEOF")).toBe("line one\nline two");
  });

  test("bare Convex id (doc comment) followed by a quoted body", () => {
    expect(extractCommentBody('k57d2v8m1q9x3z6b4n8c0f5g7h2j4l6p "looks good"')).toBe("looks good");
  });

  test("null when there is no leading entity id", () => {
    expect(extractCommentBody('"just a string"')).toBeNull();
  });

  test("null for a shell-expanded body (recipe, not delivered text)", () => {
    expect(extractCommentBody('ct-40882 "$(cat notes.md)"')).toBeNull();
  });
});

describe("extractMessageFlag", () => {
  test("extracts a double-quoted -m value", () => {
    expect(extractMessageFlag('ct-40882 -m "verified in prod"')).toBe("verified in prod");
  });

  test("extracts a single-quoted --message value", () => {
    expect(extractMessageFlag("ct-40882 --message 'all tests green'")).toBe("all tests green");
  });

  test("null when the flag is absent", () => {
    expect(extractMessageFlag("ct-40882")).toBeNull();
  });

  test("null for an expanded value", () => {
    expect(extractMessageFlag('ct-40882 -m "$SUMMARY"')).toBeNull();
  });
});

describe("extractFlagValue", () => {
  test("reads a flag value from argv", () => {
    expect(extractFlagValue('pl-88 -g "ship the parser" -b "details"', ["-g", "--goal"])).toBe(
      "ship the parser",
    );
  });

  test("ignores a flag spelled inside a heredoc body", () => {
    const args = "ct-1 - <<'EOF'\nrun it with -m to see the message\nEOF";
    expect(extractFlagValue(args, ["-m", "--message"])).toBeNull();
  });

  test("ignores a flag spelled inside a quoted body", () => {
    expect(extractFlagValue('ct-1 "pass -m to the runner" -t progress', ["-m", "--message"])).toBeNull();
  });

  test("null when the value is expanded", () => {
    expect(extractFlagValue("ct-1 --goal $GOAL", ["-g", "--goal"])).toBeNull();
  });
});

describe("normalizeCastCategory", () => {
  test("resolves short and pre-rename spellings", () => {
    expect(["t", "p", "d", "sched", "schedule", "task"].map(normalizeCastCategory)).toEqual([
      "task", "plan", "doc", "trigger", "trigger", "task",
    ]);
  });
});

describe("extractCastBodyParts", () => {
  test("comment body", () => {
    expect(extractCastBodyParts("task", "comment", 'ct-40882 "wired the parser" -t progress')).toEqual([
      { text: "wired the parser", label: undefined },
    ]);
  });

  test("heredoc comment body keeps its line breaks", () => {
    expect(extractCastBodyParts("t", "comment", "pl-88 - <<'EOF'\n# Report\n\n- one\n- two\nEOF")).toEqual([
      { text: "# Report\n\n- one\n- two", label: undefined },
    ]);
  });

  test("plan comment carries its rationale as a second part", () => {
    expect(extractCastBodyParts("plan", "comment", 'pl-88 "use postgres" -d -r "convex has no joins"')).toEqual([
      { text: "use postgres", label: undefined },
      { text: "convex has no joins", label: "why" },
    ]);
  });

  test("done note", () => {
    expect(extractCastBodyParts("task", "done", 'ct-1 -m "verified in prod"')).toEqual([
      { text: "verified in prod", label: undefined },
    ]);
  });

  test("plan create carries goal then body", () => {
    expect(extractCastBodyParts("plan", "create", '"Rewrite sync" -g "one path" -b "## Steps"')).toEqual([
      { text: "one path", label: "goal" },
      { text: "## Steps", label: undefined },
    ]);
  });

  test("trigger add carries its prompt", () => {
    expect(extractCastBodyParts("trigger", "add", '"Check if CI is green on main" --in 30m')).toEqual([
      { text: "Check if CI is green on main", label: "prompt" },
    ]);
  });

  test("trigger add reads a heredoc prompt", () => {
    const args = "- --every 4h --title \"Growth audit\" <<'EOF'\nAudit budget allocation.\nEOF";
    expect(extractCastBodyParts("sched", "add", args)).toEqual([
      { text: "Audit budget allocation.", label: "prompt" },
    ]);
  });

  test("cast state renders as its own row, never a body block", () => {
    expect(extractCastBodyParts("state", "", '--status done "Shipped and verified"')).toEqual([]);
    expect(extractCastBodyParts("state", "clear", "")).toEqual([]);
    expect(extractCastBodyParts("state", "show", "jx7c6zk")).toEqual([]);
  });

  test("queries carry nothing — a filter is not content", () => {
    expect(extractCastBodyParts("feed", "", "-m samvit")).toEqual([]);
    expect(extractCastBodyParts("task", "ls", '-q "auth"')).toEqual([]);
  });

  test("a shell-expanded body yields nothing to quote", () => {
    expect(extractCastBodyParts("task", "comment", 'ct-1 "$(cat notes.md)"')).toEqual([]);
  });
});

describe("extractStateArgs", () => {
  test("status flag plus quoted body", () => {
    expect(extractStateArgs('--status done "Shipped — all four fixes verified"')).toEqual({
      status: "done",
      headline: "Shipped — all four fixes verified",
    });
  });

  test("heredoc body yields only the first line", () => {
    const args = "--status dormant - <<'EOF'\nOps audit of Convex on Railway\nStatus: both pinned at the cap\nNext: read memory.stat\nEOF";
    expect(extractStateArgs(args)).toEqual({
      status: "dormant",
      headline: "Ops audit of Convex on Railway",
    });
  });

  test("body without a status flag", () => {
    expect(extractStateArgs('"Waiting on CI — nothing to decide"')).toEqual({
      status: null,
      headline: "Waiting on CI — nothing to decide",
    });
  });

  test("status flag after the body", () => {
    expect(extractStateArgs('"Rewrite done, tests green" --status blocked')).toEqual({
      status: "blocked",
      headline: "Rewrite done, tests green",
    });
  });

  test("a shell-expanded body is a recipe, not a headline", () => {
    expect(extractStateArgs('--status done "$(cat state.txt)"')).toEqual({
      status: "done",
      headline: null,
    });
  });

  test("bare read has neither", () => {
    expect(extractStateArgs("")).toEqual({ status: null, headline: null });
  });
});

describe("extractBrowserPageUrl", () => {
  test("takes the freshest standalone URL line from output, ignoring ANSI", () => {
    const output = "\x1b[1mPage title\x1b[0m\n\x1b[2mhttps://example.com/one\x1b[0m\nsome text\n  https://example.com/two  \n  3 refs";
    expect(extractBrowserPageUrl("snapshot", "", output)).toBe("https://example.com/two");
  });

  test("click that navigated reports the indented destination URL", () => {
    const output = "  → navigated to Dashboard\n    https://app.example.com/dash";
    expect(extractBrowserPageUrl("click", "#e42", output)).toBe("https://app.example.com/dash");
  });

  test("falls back to the open argument, normalizing a bare domain", () => {
    expect(extractBrowserPageUrl("open", "example.com/x", "")).toBe("https://example.com/x");
    expect(extractBrowserPageUrl("open", '"https://a.dev"', "")).toBe("https://a.dev");
    expect(extractBrowserPageUrl("open", "-", "")).toBeNull();
  });

  test("actions with no URL in output yield null", () => {
    expect(extractBrowserPageUrl("find", '"Sign in"', '  link "Sign in" #e12')).toBeNull();
    expect(extractBrowserPageUrl("shot", "", "  /var/folders/x/shot.png (149K)")).toBeNull();
  });
});

describe("buildBrowserRowMap", () => {
  const row = (toolCallId: string, subcommand: string, args: string, output: string) => ({ toolCallId, subcommand, args, output });

  test("carries the last known URL and tab into rows that state none", () => {
    const map = buildBrowserRowMap([
      row("t1", "open", "example.com", "Title\nhttps://example.com/\n  tab 4A2CDC7E"),
      row("t2", "find", '"Sign in"', '  link "Sign in" #e12'),
      row("t3", "click", "#e12", "  → navigated to Login\n    https://example.com/login\n  tab 4A2CDC7E"),
      row("t4", "shot", "", "  /tmp/x.png (10K)"),
      row("t5", "open", "b.dev", "B\nhttps://b.dev/\n  tab 9F00AB12"),
    ]);
    expect(map).toEqual({
      t1: { url: "https://example.com/", tabId: "4A2CDC7E" },
      t2: { url: "https://example.com/", tabId: "4A2CDC7E" },
      t3: { url: "https://example.com/login", tabId: "4A2CDC7E" },
      t4: { url: "https://example.com/login", tabId: "4A2CDC7E" },
      t5: { url: "https://b.dev/", tabId: "9F00AB12" },
    });
  });

  test("rows before any known URL or tab get nothing", () => {
    const map = buildBrowserRowMap([
      row("t1", "find", '"x"', "  nothing"),
      row("t2", "open", "a.dev", "A\nhttps://a.dev/"),
    ]);
    expect(map).toEqual({ t2: { url: "https://a.dev/" } });
  });

  test("an open row with no output yet links to its destination argument", () => {
    const map = buildBrowserRowMap([row("t1", "open", "b.dev/path", "")]);
    expect(map).toEqual({ t1: { url: "https://b.dev/path" } });
  });
});

describe("cast browser do steps", () => {
  test("splits quoted and bare steps and drops the do flags", () => {
    expect(extractBrowserDoSteps('"open example.com" "find Sign in" click --keep-going --tab 4A2C shot')).toEqual([
      { verb: "open", args: "example.com" },
      { verb: "find", args: "Sign in" },
      { verb: "click", args: "" },
      { verb: "shot", args: "" },
    ]);
  });

  test("reads one step per heredoc line", () => {
    const args = "- <<'EOF'\nopen https://example.com\nfind \"Sign in\"\nclick\nEOF";
    expect(extractBrowserDoSteps(args)).toEqual([
      { verb: "open", args: "https://example.com" },
      { verb: "find", args: '"Sign in"' },
      { verb: "click", args: "" },
    ]);
  });

  test("attributes output lines to their step and reads the pass/fail glyph", () => {
    const out = [
      "* open example.com",
      "    Example Domain — https://example.com/",
      "* find Sign in",
      "    #e12 button \"Sign in\"",
      "x click",
      "    element is covered by another element",
      "",
      "2/3 steps in 1.4s",
    ].join("\n");
    expect(splitBrowserDoOutput(out, 4)).toEqual([
      { output: "Example Domain — https://example.com/", ok: true },
      { output: '#e12 button "Sign in"', ok: true },
      { output: "element is covered by another element", ok: false },
      { output: "" },
    ]);
  });

  test("reads the engine format: › headers, glyph verdict lines, footer dropped", () => {
    const out = [
      "› open https://example.com",
      "✓ Example Domain",
      "  https://example.com/",
      "› find More information",
      "x no element matching \"More information\" (2 refs on the page); closest: - link \"Learn more\" [ref=e2]",
      "  https://example.com/",
      "  tab 023260EE",
      "  4 steps in 23.1s, 1 failed",
    ].join("\n");
    expect(splitBrowserDoOutput(out, 4)).toEqual([
      { output: "Example Domain\nhttps://example.com/", ok: true },
      { output: 'no element matching "More information" (2 refs on the page); closest: - link "Learn more" [ref=e2]', ok: false },
      { output: "" },
      { output: "" },
    ]);
  });

  test("understands the colour glyphs and ANSI from a TTY run", () => {
    const out = "\x1b[32m●\x1b[0m \x1b[1mclick\x1b[0m\n    clicked\n\x1b[31m○\x1b[0m \x1b[1mshot\x1b[0m\n    no page\n";
    expect(splitBrowserDoOutput(out, 2)).toEqual([
      { output: "clicked", ok: true },
      { output: "no page", ok: false },
    ]);
  });
});

describe("extractChatSendArgs", () => {
  const ID = "j17zg9kjy1sk58qwqgnzcecme58cdmsp";

  test("reply: placeholder id, literal text, default status", () => {
    const r = extractChatSendArgs("reply", `${ID} "Hey Ashot — Anchor here."`);
    expect(r).toEqual({ messageId: ID, channelId: undefined, threadRootId: undefined, status: undefined, body: "Hey Ashot — Anchor here.", kind: "literal" });
  });

  test("reply: --status error after the text", () => {
    const r = extractChatSendArgs("reply", `${ID} "can't reach the repo" --status error`);
    expect(r?.status).toBe("error");
    expect(r?.body).toBe("can't reach the repo");
  });

  test("reply: heredoc body", () => {
    const r = extractChatSendArgs("reply", `${ID} - <<'EOF'\nline one\nline two\nEOF`);
    expect(r?.messageId).toBe(ID);
    expect(r?.body).toBe("line one\nline two");
    expect(r?.kind).toBe("heredoc");
  });

  test("send: text before or after the flags", () => {
    const a = extractChatSendArgs("send", `--channel hx7p8 --thread j17kq "ship it"`);
    expect(a?.channelId).toBe("hx7p8");
    expect(a?.threadRootId).toBe("j17kq");
    expect(a?.body).toBe("ship it");
    const b = extractChatSendArgs("send", `"ship it" --channel hx7p8 --json`);
    expect(b?.channelId).toBe("hx7p8");
    expect(b?.body).toBe("ship it");
    expect(b?.kind).toBe("literal");
  });

  test("send: an expanded body is a recipe", () => {
    expect(extractChatSendArgs("send", `--channel hx7p8 "$(cat msg.txt)"`)?.kind).toBe("dynamic");
  });

  test("other chat subcommands are not sends", () => {
    expect(extractChatSendArgs("read", "--channel hx7p8")).toBeNull();
    expect(extractChatSendArgs("thread", "j17kq")).toBeNull();
  });
});

describe("extractDecideArgs", () => {
  const parse = (cmd: string) => {
    const p = parseCastCommandString(cmd)!;
    return extractDecideArgs(p.subcommand, p.args);
  };

  test("an ask: quoted question, options with consequences, heredoc context", () => {
    const out = parse(
      `cast decide "Which schema wins?" -o "Frontmatter wins :: stable ids" -o "Path wins" --context -  <<'EOF'\nThe daemon writes ids from the path.\n\nEither side can be authoritative.\nEOF`,
    );
    expect(out.verb).toBe("ask");
    expect(out.question).toBe("Which schema wins?");
    expect(out.options).toEqual([{ label: "Frontmatter wins", description: "stable ids" }, { label: "Path wins" }]);
    expect(out.context).toBe("The daemon writes ids from the path.\n\nEither side can be authoritative.");
    expect(out.advisory).toBe(false);
    expect(out.defaultOption).toBeUndefined();
  });

  test("an advisory ask carries a 0-based default and an inline context", () => {
    const out = parse(`cast decide "Back off or switch keys?" -o "Back off" -o "Switch keys" --advisory --default 2 --context "429s for 4m."`);
    expect(out.advisory).toBe(true);
    expect(out.defaultOption).toBe(1);
    expect(out.context).toBe("429s for 4m.");
  });

  test("a shell-expanded context is a recipe, not the delivered text", () => {
    const out = parse(`cast decide "Q?" -o A -o B --context "$(cat notes.md)"`);
    expect(out.context).toBeNull();
    expect(out.question).toBe("Q?");
  });

  test("a report path is kept", () => {
    expect(parse(`cast decide "Drop it?" -o Yes -o No --report drop-analysis.html`).report).toBe("drop-analysis.html");
  });

  test("edit with an id and a new context", () => {
    const out = parse(`cast decide edit k57abcdefghijklmnopqrstuv --context - <<'EOF'\nNew facts.\nEOF`);
    expect(out.verb).toBe("edit");
    expect(out.decisionId).toBe("k57abcdefghijklmnopqrstuv");
    expect(out.context).toBe("New facts.");
    expect(out.question).toBeNull();
  });

  test("edit without an id: --question and --blocking", () => {
    const out = parse(`cast decide edit --question "Merge or rebase?" --blocking`);
    expect(out.decisionId).toBeUndefined();
    expect(out.question).toBe("Merge or rebase?");
    expect(out.blocking).toBe(true);
  });

  test("cancel and its aliases", () => {
    expect(parse("cast decide cancel").verb).toBe("cancel");
    expect(parse("cast decide rm k57abcdefghijklmnopqrstuv")).toMatchObject({ verb: "cancel", decisionId: "k57abcdefghijklmnopqrstuv" });
  });

  test("ls parses to the list verb with nothing else", () => {
    expect(parse("cast decide ls")).toMatchObject({ verb: "ls", options: [] });
  });

  test("an unquoted question folds the first word back out of the subcommand slot", () => {
    const out = parse("cast decide Ship -o Yes -o No --context why");
    expect(out.verb).toBe("ask");
    expect(out.question).toBe("Ship");
    expect(out.options.map((o) => o.label)).toEqual(["Yes", "No"]);
  });
});
