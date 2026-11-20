import { describe, expect, test } from "bun:test";
import { unreachableTerminalOf } from "@codecast/shared/contracts/deliveryHold";
import { findOrcaCli, orcaKeyBytes, orcaPane, orcaPastePayload, parseOrcaJson, type OrcaIo } from "./orca.js";
import { terminalProgramForApp } from "./processEnv.js";
import { TerminalHoldError } from "./terminalHold.js";

const PANE_KEY = "tab-1:leaf-2";
const list = (terminals: unknown[]) => JSON.stringify({ id: "x", ok: true, result: { terminals } });

function fakeIo(terminals: unknown[] = [{ handle: "term_live", tabId: "tab-1", leafId: "leaf-2", writable: true }]) {
  const sent: string[] = [];
  const io: OrcaIo = {
    cli: () => "/Applications/Orca.app/Contents/Resources/bin/orca",
    run: async (_cli, args) => {
      if (args[1] === "list") return list(terminals);
      expect(args.slice(2, 4)).toEqual(["--terminal", "term_live"]);
      if (args[1] === "send") { sent.push(args[args.indexOf("--text") + 1]); return JSON.stringify({ ok: true, result: {} }); }
      if (args[1] === "read") return JSON.stringify({ ok: true, result: { terminal: { tail: ["one", "❯ "] } } });
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  };
  return { io, sent };
}

describe("orca", () => {
  // `orca terminal send --text` writes bytes as given and never brackets a
  // paste itself (checked against Orca 1.4.159 with a raw-mode byte logger).
  test("wraps message text as a bracketed paste only for a client that takes one", () => {
    expect(orcaPastePayload("line1\nline2\n", true)).toBe("\x1b[200~line1\nline2\x1b[201~");
    expect(orcaPastePayload("line1\nline2", false)).toBe("line1 line2");
  });

  test("sends poll keys as their terminal bytes", () => {
    expect(["Enter", "Return", "Escape", "Up", "Down", "1", "y"].map(orcaKeyBytes)).toEqual(["\r", "\r", "\x1b", "\x1b[A", "\x1b[B", "1", "y"]);
  });

  test("a refused request throws its error code", () => {
    expect(() => parseOrcaJson(JSON.stringify({ ok: false, error: { code: "terminal_handle_stale" } }))).toThrow("terminal_handle_stale");
    expect(parseOrcaJson(list([]))).toEqual({ terminals: [] });
  });

  test("finds the CLI on PATH, then in the app bundle", () => {
    const at = (...present: string[]) => (p: string) => present.includes(p);
    expect(findOrcaCli(at("/opt/bin/orca"), "/usr/bin:/opt/bin", "/Users/a")).toBe("/opt/bin/orca");
    expect(findOrcaCli(at("/Applications/Orca.app/Contents/Resources/bin/orca"), "/usr/bin", "/Users/a")).toBe("/Applications/Orca.app/Contents/Resources/bin/orca");
    expect(findOrcaCli(at("/Users/a/Applications/Orca.app/Contents/Resources/bin/orca"), "/usr/bin", "/Users/a")).toBe("/Users/a/Applications/Orca.app/Contents/Resources/bin/orca");
    expect(findOrcaCli(at(), "/usr/bin", "/Users/a")).toBeNull();
  });

  // The handle an agent was started with goes stale when Orca restarts; its
  // pane key does not, so the live handle is looked up from it each time.
  test("addresses the live terminal for the agent's pane key", async () => {
    const { io, sent } = fakeIo([
      { handle: "term_other", tabId: "tab-1", leafId: "leaf-9" },
      { handle: "term_live", tabId: "tab-1", leafId: "leaf-2", writable: true },
    ]);
    const pane = await orcaPane(PANE_KEY, true, () => {}, io);
    await pane.sendText("hi");
    await pane.sendKey("Enter");
    await pane.sendKeystrokes("\x1b");
    expect(sent).toEqual(["\x1b[200~hi\x1b[201~", "\r", "\x1b"]);
    expect(await pane.readScreen()).toBe("one\n❯ ");
  });

  test("a pane Orca no longer lists is a failure, not a hold", async () => {
    const { io } = fakeIo([]);
    const err = await orcaPane(PANE_KEY, true, () => {}, io).catch((e) => e);
    expect(err).not.toBeInstanceOf(TerminalHoldError);
    expect(err.message).toContain("Orca terminal not found");
  });

  test.each([
    ["no pane key", undefined, fakeIo().io],
    ["no CLI", PANE_KEY, { ...fakeIo().io, cli: () => null }],
    ["Orca not answering", PANE_KEY, { ...fakeIo().io, run: async () => { throw new Error("connect ECONNREFUSED"); } }],
    ["a read-only terminal", PANE_KEY, fakeIo([{ handle: "term_live", tabId: "tab-1", leafId: "leaf-2", writable: false }]).io],
  ])("%s holds the message with Orca named", async (_case, key, io) => {
    const err = await orcaPane(key, true, () => {}, io as OrcaIo).catch((e) => e);
    expect(err).toBeInstanceOf(TerminalHoldError);
    expect(unreachableTerminalOf(err.holdReason)).toBe("Orca");
  });

  // An agent whose environment is unreadable is attributed from the app that owns its tty.
  test("names Orca from its app or helper process", () => {
    expect(terminalProgramForApp("/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper")).toBe("Orca");
    expect(terminalProgramForApp("/Applications/Orca.app/Contents/MacOS/Orca")).toBe("Orca");
  });
});
