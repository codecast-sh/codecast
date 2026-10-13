import { describe, expect, test } from "bun:test";
import {
  expandStdinArgs,
  prepareSessionSendBody,
  readStdinBody,
  removeStdinTransportNewline,
} from "./sendBody";

describe("removeStdinTransportNewline", () => {
  test("removes one LF added by a heredoc transport", () => {
    expect(removeStdinTransportNewline("briefing\n")).toBe("briefing");
  });

  test("removes one CRLF transport terminator", () => {
    expect(removeStdinTransportNewline("briefing\r\n")).toBe("briefing");
  });

  test("preserves leading indentation and intentional trailing blank lines", () => {
    expect(removeStdinTransportNewline("    const answer = 42;\n\n\n")).toBe(
      "    const answer = 42;\n\n",
    );
  });

  test("does not alter input without a terminal newline", () => {
    expect(removeStdinTransportNewline("  exact body  ")).toBe("  exact body  ");
  });
});

describe("prepareSessionSendBody", () => {
  test("does not trim an inline quoted body", () => {
    expect(prepareSessionSendBody("  exact body  ", false)).toBe("  exact body  ");
  });

  test("only stdin receives transport-newline normalization", () => {
    expect(prepareSessionSendBody("body\n", false)).toBe("body\n");
    expect(prepareSessionSendBody("body\n", true)).toBe("body");
  });
});

describe("readStdinBody", () => {
  test("strips exactly the one transport newline from the stdin body", () => {
    expect(readStdinBody(() => "# Brief\n\nsteps\n")).toBe("# Brief\n\nsteps");
  });
});

describe("expandStdinArgs", () => {
  test("passes non-dash arguments through untouched", () => {
    expect(expandStdinArgs(["task a", "task b"], () => "unused")).toEqual(["task a", "task b"]);
  });

  test("expands a single '-' to the stdin body in place", () => {
    expect(expandStdinArgs(["task a", "-", "task c"], () => "multi\nline\n")).toEqual([
      "task a",
      "multi\nline",
      "task c",
    ]);
  });

  test("a literal dash inside a longer argument is not stdin", () => {
    expect(expandStdinArgs(["--", "a-b"], () => "unused")).toEqual(["--", "a-b"]);
  });

  test("a single '-' never splits — a lone --- line is content, not a separator", () => {
    expect(expandStdinArgs(["-"], () => "intro\n---\noutro\n")).toEqual(["intro\n---\noutro"]);
  });

  test("multiple '-' args split stdin into sections on --- lines, in order", () => {
    expect(
      expandStdinArgs(["keep", "-", "-", "-"], () => "brief one\nline two\n---\nbrief two\n---\nbrief three\n"),
    ).toEqual(["keep", "brief one\nline two", "brief two", "brief three"]);
  });

  test("splits on CRLF-delimited --- lines too", () => {
    expect(expandStdinArgs(["-", "-"], () => "a\r\n---\r\nb\r\n")).toEqual(["a", "b"]);
  });

  test("rejects a section count that does not match the '-' count", () => {
    expect(() => expandStdinArgs(["-", "-", "-"], () => "one\n---\ntwo\n")).toThrow(
      `3 '-' arguments need 3 stdin sections`,
    );
  });
});

describe("expandCommandStdinDashes", () => {
  const { Command } = require("commander");
  const { expandCommandStdinDashes, stdinText, takesStdinDash } = require("./sendBody");

  function parsed(setup: (cmd: any) => void, argv: string[]) {
    const program = new Command();
    program.exitOverride();
    let seen: { args: any[]; opts: any } | undefined;
    const cmd = program.command("x");
    setup(cmd);
    cmd.action((...actionArgs: any[]) => {
      const command = actionArgs.pop();
      const opts = actionArgs.pop();
      seen = { args: actionArgs, opts };
      void command;
    });
    return { program, cmd, run: () => { program.parse(["node", "cast", "x", ...argv]); return seen!; } };
  }

  test("stdinText marks a description and takesStdinDash reads the mark", () => {
    expect(takesStdinDash(stdinText("Description"))).toBe(true);
    expect(takesStdinDash(stdinText("Prompts", { many: true }))).toBe(true);
    expect(takesStdinDash("Read content from file ('-' for stdin)")).toBe(false);
    expect(takesStdinDash(undefined)).toBe(false);
  });

  test("expands a '-' option value that the help promises (the task create -d - bug)", () => {
    const t = parsed((cmd) => {
      cmd.argument("<title>", stdinText("Title")).option("-d, --description <text>", stdinText("Description"));
      cmd.hook("preAction", (_: any, action: any) => expandCommandStdinDashes(action, () => "line one\nline two\n"));
    }, ["Swap cards", "-d", "-"]);
    const seen = t.run();
    expect(seen.args[0]).toBe("Swap cards");
    expect(seen.opts.description).toBe("line one\nline two");
  });

  test("leaves a '-' alone on an option whose help does not promise stdin", () => {
    let reads = 0;
    const t = parsed((cmd) => {
      cmd.argument("<id>").option("--content-file <path>", "Read content from file ('-' for stdin)");
      cmd.hook("preAction", (_: any, action: any) => expandCommandStdinDashes(action, () => { reads++; return "body"; }));
    }, ["doc1", "--content-file", "-"]);
    expect(t.run().opts.contentFile).toBe("-");
    expect(reads).toBe(0);
  });

  test("a variadic positional splits stdin on --- lines, one section per '-'", () => {
    const t = parsed((cmd) => {
      cmd.argument("[directions...]", stdinText("Directions", { many: true }));
      cmd.hook("preAction", (_: any, action: any) => expandCommandStdinDashes(action, () => "first brief\n---\nsecond brief\n"));
    }, ["-", "-"]);
    expect(t.run().args[0]).toEqual(["first brief", "second brief"]);
  });

  test("positionals take stdin sections before options, in declared order", () => {
    const t = parsed((cmd) => {
      cmd.argument("<title>", stdinText("Title")).option("-d, --description <text>", stdinText("Description"));
      cmd.hook("preAction", (_: any, action: any) => expandCommandStdinDashes(action, () => "the title\n---\nthe body\n"));
    }, ["-d", "-", "-"]);
    const seen = t.run();
    expect(seen.args[0]).toBe("the title");
    expect(seen.opts.description).toBe("the body");
  });

  test("does not touch stdin when nothing is '-'", () => {
    let reads = 0;
    const t = parsed((cmd) => {
      cmd.argument("<text>", stdinText("Text"));
      cmd.hook("preAction", (_: any, action: any) => expandCommandStdinDashes(action, () => { reads++; return ""; }));
    }, ["plain"]);
    expect(t.run().args[0]).toBe("plain");
    expect(reads).toBe(0);
  });
});

describe("rejectBareDash", () => {
  const { rejectBareDash } = require("./sendBody");
  test("names the field holding an unexpanded '-'", () => {
    expect(() => rejectBareDash({ title: "ok", description: "-" })).toThrow(/^description is a bare '-'/);
  });
  test("lets ordinary bodies through, including dashes inside text", () => {
    expect(() => rejectBareDash({ title: "a-b", text: "- bullet\n- bullet", n: 3, tags: ["-"] })).not.toThrow();
  });
});
