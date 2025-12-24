import { describe, test, expect, mock } from "bun:test";
import { parseSessionLine, parseLine, parseCodexLine } from "./parser.js";

describe("Parser malformed JSON handling", () => {
  test("parseSessionLine logs warning and returns null for malformed JSON", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const result = parseSessionLine('this is not valid json');

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalled();
    expect(consoleWarnSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(consoleWarnSpy.mock.calls[0][0]).toContain('[parser] Failed to parse session line');
    expect(consoleWarnSpy.mock.calls[1][0]).toContain('[parser] Line content:');

    console.warn = originalWarn;
  });

  test("parseSessionLine handles valid JSON correctly", () => {
    const validJson = '{"type":"user","message":{"role":"user","content":"test"},"timestamp":"2025-12-24T00:00:00.000Z"}';
    const result = parseSessionLine(validJson);

    expect(result).not.toBeNull();
    expect(result?.type).toBe("user");
  });

  test("parseSessionLine returns null for empty lines without logging", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const result = parseSessionLine('   ');

    expect(result).toBeNull();
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    console.warn = originalWarn;
  });

  test("parseLine logs warning for malformed JSON", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const result = parseLine('invalid json {{{');

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalled();

    console.warn = originalWarn;
  });

  test("parseCodexLine logs warning for malformed JSON", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const result = parseCodexLine('not valid json');

    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalled();

    console.warn = originalWarn;
  });

  test("parseSessionLine truncates long malformed lines in warning", () => {
    const consoleWarnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleWarnSpy;

    const longLine = 'x'.repeat(200);
    parseSessionLine(longLine);

    expect(consoleWarnSpy).toHaveBeenCalled();
    const contentWarning = consoleWarnSpy.mock.calls[1][0];
    expect(contentWarning.length).toBeLessThan(longLine.length + 50);
    expect(contentWarning).toContain('...');

    console.warn = originalWarn;
  });
});
