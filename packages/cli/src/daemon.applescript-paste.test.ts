import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAppleScript,
  writeKittyInjectionPayload,
  writeTerminalInjectionScript,
} from "./daemon.js";

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
    const source = readFileSync(join(import.meta.dir, "daemon.ts"), "utf8");
    const kitty = source.slice(
      source.indexOf("async function injectViaKitty("),
      source.indexOf("// ── WezTerm injection"),
    );
    const wezterm = source.slice(
      source.indexOf("async function injectViaWezTerm("),
      source.indexOf("// ── Terminal injection router"),
    );

    expect(kitty).toContain("await pasteAndSubmitText({");
    expect(kitty).toContain("paste: () => kittySendText(match, content, bracketed)");
    expect(kitty).toContain("submit: () => execAsync(`kitty @ send-key ${match} enter`)");
    expect(wezterm).toContain("await pasteAndSubmitText({");
    expect(wezterm).toContain("paste: () => weztermSendText(paneId, content, { bracketed })");
    expect(wezterm).toContain('submit: () => weztermSendKeys(paneId, "\\r")');
  });
});
