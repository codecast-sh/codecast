import { test, expect, describe } from "bun:test";
import { stripCdPrefix, unwrapShellCommand, parseCastCommandString } from "./castCommand";

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

describe("unwrapShellCommand", () => {
  test("unwraps single- and double-quoted bash -c", () => {
    expect(unwrapShellCommand(`bash -c 'cast feed'`)).toBe("cast feed");
    expect(unwrapShellCommand(`/bin/sh -c "cast sessions"`)).toBe("cast sessions");
  });

  test("returns the command unchanged when not wrapped", () => {
    expect(unwrapShellCommand("cast send jx7a6xc hi")).toBe("cast send jx7a6xc hi");
  });
});
