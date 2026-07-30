import { test, expect, describe } from "bun:test";
import { stripCdPrefix, unwrapShellCommand, parseCastCommandString, extractSendBody } from "./castCommand";

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

  test("command substitution in double quotes is dynamic (the jx7bt1x misread)", () => {
    const r = extractSendBody('"$(cat reply.md)"');
    expect(r.kind).toBe("dynamic");
    expect(r.body).toBe("$(cat reply.md)");
  });

  test("variable expansion in double quotes is dynamic", () => {
    expect(extractSendBody('"done: $RESULT"').kind).toBe("dynamic");
  });

  test("escaped dollar in double quotes stays literal", () => {
    expect(extractSendBody('"costs \\$5"').kind).toBe("literal");
  });

  test("heredoc body is extracted verbatim", () => {
    const args = "- <<'EOF'\n# Briefing\n\n- item one\n- item two\nEOF";
    expect(extractSendBody(args)).toEqual({ body: "# Briefing\n\n- item one\n- item two", kind: "heredoc" });
  });

  test("heredoc with unquoted tag and flags before it", () => {
    const args = "- --from jx7abcd <<EOF\nhello\nthere\nEOF";
    expect(extractSendBody(args)).toEqual({ body: "hello\nthere", kind: "heredoc" });
  });

  test("<<- heredoc strips leading tabs", () => {
    const args = "- <<-EOF\n\tindented\n\tlines\n\tEOF";
    expect(extractSendBody(args)).toEqual({ body: "indented\nlines", kind: "heredoc" });
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
