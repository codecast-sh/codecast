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
  test("Kitty and WezTerm route normal text through paste-then-one-submit", () => {
    const submission = (name: string) => {
      const body = functionBlock(source, name).text;
      const start = body.indexOf("await pasteAndSubmitText({");
      expect(start).toBeGreaterThanOrEqual(0);
      return blockAt(body, start).text;
    };
    const kitty = submission("injectViaKitty");
    const wezterm = submission("injectViaWezTerm");

    expect(kitty).toContain("paste: () => kittySendText(match, content, bracketed, beforeInput)");
    expect(kitty.match(/kittySendText\(/g)).toHaveLength(1);
    expect(kitty.match(/kitty @ send-key/g)).toHaveLength(1);
    expect(kitty).toContain("submit: async () => {");
    expect(kitty).toContain("await beforeInput?.()");
    expect(kitty.indexOf("await beforeInput?.()")).toBeLessThan(kitty.indexOf("kitty @ send-key"));
    expect(kitty).toContain("await execAsync(`kitty @ send-key ${match} enter`)");
    expect(wezterm).toContain("paste: async () => {");
    expect(wezterm).toContain("await weztermSendText(paneId, content, { bracketed })");
    expect(wezterm.match(/weztermSendText\(/g)).toHaveLength(1);
    expect(wezterm.match(/weztermSendKeys\(/g)).toHaveLength(1);
    expect(wezterm).toContain("await beforeInput?.()");
    expect(wezterm.indexOf("await beforeInput?.()")).toBeLessThan(wezterm.indexOf("await weztermSendText("));
    const submit = wezterm.slice(wezterm.indexOf("submit: async () => {"));
    expect(submit).toContain("await beforeInput?.()");
    expect(submit.indexOf("await beforeInput?.()")).toBeLessThan(submit.indexOf("await weztermSendKeys("));
    expect(submit).toContain('await weztermSendKeys(paneId, "\\r")');
  });
});
