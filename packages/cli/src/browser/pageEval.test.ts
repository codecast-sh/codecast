/**
 * The pure seams of `eval`/`grant`: value rendering and permission-name
 * mapping. The CDP round-trips are exercised end to end by hand (the verbs
 * exist because agents drive real pages), not mocked here.
 */

import { describe, expect, test } from "bun:test";
import { renderEvalForReading, renderEvalValue, toCdpPermissions } from "./pageEval.js";

describe("renderEvalValue", () => {
  test("plain values print as JSON, like the engine did", () => {
    expect(renderEvalValue({ type: "string", value: "hi" })).toBe('"hi"');
    expect(renderEvalValue({ type: "number", value: 5 })).toBe("5");
    expect(renderEvalValue({ type: "object", value: { a: 1 } })).toBe('{"a":1}');
  });

  test("undefined says so instead of printing null", () => {
    expect(renderEvalValue({ type: "undefined" })).toBe("undefined");
  });

  test("unserializable results fall back to the description", () => {
    expect(renderEvalValue({ type: "object", description: "HTMLDivElement" })).toBe("HTMLDivElement");
  });
});

describe("toCdpPermissions", () => {
  test("friendly names map to CDP types; duplicates collapse", () => {
    expect(toCdpPermissions(["camera", "mic", "microphone"])).toEqual(["videoCapture", "audioCapture"]);
  });

  test("clipboard fans out to both write grants", () => {
    expect(toCdpPermissions(["clipboard"])).toEqual(["clipboardReadWrite", "clipboardSanitizedWrite"]);
  });

  test("unknown names pass through for future CDP types", () => {
    expect(toCdpPermissions(["backgroundSync"])).toEqual(["backgroundSync"]);
  });
});

describe("renderEvalForReading", () => {
  test("a string prints as itself: newlines kept, a stringified object not encoded twice", () => {
    expect(renderEvalForReading({ type: "string", value: "line one\nline two" })).toBe("line one\nline two");
    expect(renderEvalForReading({ type: "string", value: '{"a":["<a href=\\"x\\">"]}' })).toBe('{"a":["<a href=\\"x\\">"]}');
  });

  test("short values stay on one line, long objects are indented", () => {
    expect(renderEvalForReading({ type: "number", value: 5 })).toBe("5");
    expect(renderEvalForReading({ type: "object", value: { a: 1 } })).toBe('{"a":1}');
    const big = { rows: Array.from({ length: 12 }, (_, i) => ({ id: i, name: `row ${i}` })) };
    expect(renderEvalForReading({ type: "object", value: big })).toBe(JSON.stringify(big, null, 2));
  });

  test("values with no JSON form keep their description", () => {
    expect(renderEvalForReading({ type: "undefined" })).toBe("undefined");
    expect(renderEvalForReading({ type: "object", description: "HTMLDivElement" })).toBe("HTMLDivElement");
  });
});
