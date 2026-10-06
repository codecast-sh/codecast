import { describe, expect, test } from "bun:test";
import { BUILDER_SYSTEM, TRIAGE_SYSTEM, buildPrompt, finishProblems, parseTriage, triagePrompt } from "./prompts";

describe("parseTriage", () => {
  test("reads one word, tolerating case and punctuation", () => {
    expect(parseTriage("change")).toBe("change");
    expect(parseTriage("Chat.")).toBe("chat");
    expect(parseTriage("  CHANGE\n")).toBe("change");
  });

  test("anything ambiguous or empty is no answer, which settles as chat", () => {
    expect(parseTriage("")).toBeNull();
    expect(parseTriage("change or chat?")).toBeNull();
    expect(parseTriage("changes")).toBeNull();
  });
});

describe("prompts", () => {
  test("the system prompts are constant text with no emdashes", () => {
    for (const p of [BUILDER_SYSTEM, TRIAGE_SYSTEM]) expect(p).not.toContain("—");
    expect(BUILDER_SYSTEM).toContain('from "playground"');
  });

  test("a build prompt carries the request, the pointed element, the room, history and files", () => {
    const text = buildPrompt({
      app: "Frog Choir",
      base: 3,
      next: 4,
      asker: "Pocket",
      request: "make this green",
      element: { selector: "main > button", tag: "button", text: "Croak" },
      room: [{ who: "Rio", body: "the button is\nugly" }],
      history: [{ number: 3, summary: "Adds a croak button", who: "Rio" }],
      files: [{ path: "src/App.jsx", text: "export default 1;" }],
      listing: "src/App.jsx (17 bytes)",
    });
    expect(text).toContain('Pocket asked you to change "Frog Choir" (now v3; your change becomes v4)');
    expect(text).toContain("> make this green");
    expect(text).toContain("- selector: main > button");
    expect(text).toContain("Rio: the button is ugly");
    expect(text).toContain("v3 (Rio): Adds a croak button");
    expect(text).toContain("## src/App.jsx\n\n```jsx\nexport default 1;\n```");
  });

  test("a big app sends a listing instead of files", () => {
    const text = buildPrompt({ app: "A", base: 1, next: 2, asker: "P", request: "x", element: null, room: [], history: [], files: null, listing: "index.html (9 bytes)" });
    expect(text).toContain("# Files (read what you need)\n\nindex.html (9 bytes)");
    expect(text).not.toContain("# The room");
  });

  test("finish problems count the tries left", () => {
    expect(finishProblems(["a"], 2)).toContain("(2 tries left)");
    expect(finishProblems(["a"], 1)).toContain("(1 try left)");
    expect(finishProblems(["a"], 0)).toContain("No tries left");
  });

  test("triage sees the element and the room", () => {
    const text = triagePrompt({ body: "bigger", element: { selector: "h1", tag: "h1", text: "Hi" }, room: [{ who: "Rio", body: "hey" }] });
    expect(text).toContain("Rio: hey");
    expect(text).toContain('<h1> element in the app reading "Hi"');
  });
});
