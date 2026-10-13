import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PASTE_START, PASTE_END, prepareInjectedContent } from "./tmuxPaste";
import { blockAt, functionBlock } from "./test-helpers/sourceRegion";

const source = readFileSync(join(import.meta.dir, "daemon.ts"), "utf8");
const helpers = ["buildAppleScript", "writeKittyInjectionPayload", "writeTerminalInjectionScript", "pollDeclineText", "pollMenuSteps"]
  .map(name => functionBlock(source, name).text).join("\n").replace(/^export /gm, "");
const { buildAppleScript, writeKittyInjectionPayload, writeTerminalInjectionScript } = new Function(
  "fs", "path", "randomUUID", "CONFIG_DIR", "prepareInjectedContent", "PASTE_START", "PASTE_END",
  new Bun.Transpiler({ loader: "ts" }).transformSync(helpers) +
    "; return { buildAppleScript, writeKittyInjectionPayload, writeTerminalInjectionScript };",
)(fs, path, randomUUID, "", prepareInjectedContent, PASTE_START, PASTE_END);

const MULTILINE = 'first \\\\ path and "quotes"\nsecond line\nthird line';
const MENU_WITH_TEXT_FIELD = { keys: ["4"], text: MULTILINE };

describe("buildAppleScript multiline paste", () => {
  test("builds a valid bracketed expression without embedding raw marker bytes", () => {
    const { script } = buildAppleScript(
      "iTerm2",
      "/dev/ttys001",
      "",
      MENU_WITH_TEXT_FIELD,
      false,
      true,
    );

    expect(script).toContain('(ASCII character 27) & "[200~"');
    expect(script).toContain('(ASCII character 27) & "[201~"');
    expect(script).toContain('first \\\\\\\\ path and \\"quotes\\"\nsecond line\nthird line');
    expect(script).not.toContain("\x1b[200~");
    expect(script).not.toContain("\x1b[201~");
  });

  test("flattens unverified-client text and emits no paste markers", () => {
    const { script } = buildAppleScript(
      "iTerm2",
      "/dev/ttys001",
      "",
      MENU_WITH_TEXT_FIELD,
      false,
      false,
    );

    expect(script).toContain('first \\\\\\\\ path and \\"quotes\\" second line third line');
    expect(script).not.toContain("[200~");
    expect(script).not.toContain("[201~");
    expect(script).not.toContain("\nsecond line");
  });
});

describe("writeTerminalInjectionScript", () => {
  test("uses a unique exclusive 0600 file for every concurrent-safe invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "codecast-applescript-test-"));
    const paths: string[] = [];
    try {
      paths.push(writeTerminalInjectionScript("script one", directory));
      paths.push(writeTerminalInjectionScript("script two", directory));

      expect(paths[0]).not.toBe(paths[1]);
      expect(paths[0]).toMatch(/terminal-inject-\d+-[0-9a-f-]{36}\.scpt$/);
      expect(paths[1]).toMatch(/terminal-inject-\d+-[0-9a-f-]{36}\.scpt$/);
      expect(readFileSync(paths[0], "utf8")).toBe("script one");
      expect(readFileSync(paths[1], "utf8")).toBe("script two");
      expect(statSync(paths[0]).mode & 0o777).toBe(0o600);
      expect(statSync(paths[1]).mode & 0o777).toBe(0o600);
    } finally {
      for (const file of paths) {
        try {
          unlinkSync(file);
        } catch {}
      }
      rmdirSync(directory);
    }
  });
});

describe("writeKittyInjectionPayload", () => {
  test("uses a unique exclusive 0600 file for every invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "codecast-kitty-test-"));
    const paths: string[] = [];
    try {
      paths.push(writeKittyInjectionPayload("secret one", directory));
      paths.push(writeKittyInjectionPayload("secret two", directory));

      expect(paths[0]).not.toBe(paths[1]);
      expect(paths[0]).toMatch(/kitty-inject-\d+-[0-9a-f-]{36}$/);
      expect(paths[1]).toMatch(/kitty-inject-\d+-[0-9a-f-]{36}$/);
      expect(readFileSync(paths[0], "utf8")).toBe("secret one");
      expect(readFileSync(paths[1], "utf8")).toBe("secret two");
      expect(statSync(paths[0]).mode & 0o777).toBe(0o600);
      expect(statSync(paths[1]).mode & 0o777).toBe(0o600);
    } finally {
      for (const file of paths) {
        try {
          unlinkSync(file);
        } catch {}
      }
      rmdirSync(directory);
    }
  });
});

describe("direct terminal message submission", () => {
  test("Kitty, WezTerm and herdr route normal text through paste-then-one-submit", () => {
    const body = functionBlock(source, "injectThroughPane").text;
    const start = body.indexOf("await pasteAndSubmitText({");
    expect(start).toBeGreaterThanOrEqual(0);
    const submission = blockAt(body, start).text;

    expect(submission).toContain("paste: () => t.sendText(content, beforeInput)");
    expect(submission.match(/sendText\(/g)).toHaveLength(1);
    expect(submission.match(/sendKey\(/g)).toHaveLength(1);
    const submit = submission.slice(submission.indexOf("submit: async () => {"));
    expect(submit).toContain("await beforeInput?.()");
    expect(submit.indexOf("await beforeInput?.()")).toBeLessThan(submit.indexOf('await t.sendKey("Enter")'));

    for (const name of ["injectViaKitty", "injectViaWezTerm", "injectViaHerdr"]) {
      expect(functionBlock(source, name).text).toContain("await injectThroughPane(");
    }
  });

  test("each transport runs the input guard right before it writes message text", () => {
    expect(functionBlock(source, "kittySendText").text).toContain("await beforeInput?.()");
    for (const name of ["injectViaWezTerm", "injectViaHerdr"]) {
      const body = functionBlock(source, name).text;
      const send = body.slice(body.indexOf("sendText: async (text, beforeInput) => {"));
      expect(send.indexOf("await beforeInput?.()")).toBeGreaterThanOrEqual(0);
      expect(send.indexOf("await beforeInput?.()")).toBeLessThan(send.indexOf("sendKey:"));
    }
  });
});
