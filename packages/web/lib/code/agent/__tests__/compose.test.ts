// What the editor hands an agent: a pending quote (Cmd-L), one message with an
// instruction (Cmd-K) sent through the store's own send path, and a new
// session's opening text.
import { describe, expect, it } from "bun:test";
import { codeQuoteComment, codeQuoteText, fenceLang, instructionMessage, newSessionText, rangeLabel, sendInstruction, type CodeRange, type SendPort } from "../compose";

const file = ["import x from 'y';", "", "export function add(a, b) {", "  return a + b;", "}", "", "add(1, 2);"];
const range = (startLine: number, endLine: number, over: Partial<CodeRange> = {}): CodeRange => ({
  absPath: "/r/app/src/math.ts",
  startLine,
  endLine,
  code: file.slice(startLine - 1, endLine).join("\n"),
  lang: "ts",
  context: { linesFrom: 1, lines: file },
  ...over,
});

describe("quote text", () => {
  it("labels one line and a range", () => {
    expect(rangeLabel(range(4, 4))).toBe("/r/app/src/math.ts:L4");
    expect(rangeLabel(range(3, 5))).toBe("/r/app/src/math.ts:L3-5");
  });

  it("fences the code under its label", () => {
    expect(codeQuoteText(range(3, 5))).toBe("/r/app/src/math.ts:L3-5\n```ts\nexport function add(a, b) {\n  return a + b;\n}\n```");
  });

  it("a backtick run inside the code gets a longer fence", () => {
    const t = codeQuoteText(range(1, 1, { code: "const s = ```x```;", lang: "" }));
    expect(t.split("\n")[1]).toBe("````");
    expect(t.endsWith("\n````")).toBe(true);
  });

  it("CRLF and a trailing newline are normalized", () => {
    expect(codeQuoteText(range(1, 2, { code: "a\r\nb\r\n", lang: "" }))).toBe("/r/app/src/math.ts:L1-2\n```\na\nb\n```");
  });

  it("fence language comes from the extension", () => {
    expect(fenceLang("/a/b.TSX")).toBe("tsx");
    expect(fenceLang("/a/Makefile")).toBe("");
    expect(fenceLang("/a/.env")).toBe("");
  });
});

describe("pending quote (Cmd-L)", () => {
  it("carries the vault-absolute path, the last line and an anchor with context", () => {
    const c = codeQuoteComment(range(3, 4), 1000);
    expect(c).toMatchObject({ messageId: "file:/r/app/src/math.ts", body: "", createdAt: 1000, filePath: "/r/app/src/math.ts", fileLine: 4, blockIndex: 3 });
    expect(c.quote).toBe(codeQuoteText(range(3, 4)));
    expect(c.anchorLines?.lines).toEqual(["export function add(a, b) {", "return a + b;"]);
    expect(c.anchorLines?.before.at(-1)).toBe("");
    expect(c.anchorLines?.after[0]).toBe("}");
    expect(c.id).toBeTruthy();
  });

  it("anchors with partial context (the context window starts mid-file)", () => {
    const c = codeQuoteComment(range(4, 4, { context: { linesFrom: 3, lines: file.slice(2, 5) } }));
    expect(c.anchorLines?.lines).toEqual(["return a + b;"]);
    expect(c.anchorLines?.before).toEqual(["export function add(a, b) {"]);
  });
});

describe("instruction (Cmd-K)", () => {
  it("is the quote as a blockquote, then the instruction, as every quoted reply is", () => {
    const msg = instructionMessage(range(4, 4), "  use checked addition  ");
    expect(msg).toBe("> /r/app/src/math.ts:L4\n> ```ts\n>   return a + b;\n> ```\n\nuse checked addition");
  });

  const stub = () => {
    const calls: unknown[][] = [];
    const port: SendPort = {
      addOptimisticMessage: (convId, content) => {
        calls.push(["optimistic", convId, content]);
        return "client-1";
      },
      sendMessage: (convId, content, imageIds, clientId) => {
        calls.push(["send", convId, content, imageIds, clientId]);
      },
    };
    return { port, calls };
  };

  it("sends ONE message through the store: an optimistic bubble, then sendMessage with its client id", () => {
    const { port, calls } = stub();
    const id = sendInstruction(port, "sess1", range(3, 5), "rename to sum");
    const text = instructionMessage(range(3, 5), "rename to sum");
    expect(id).toBe("client-1");
    expect(calls).toEqual([
      ["optimistic", "sess1", text],
      ["send", "sess1", text, undefined, "client-1"],
    ]);
  });

  it("an empty instruction sends nothing", () => {
    const { port, calls } = stub();
    expect(sendInstruction(port, "sess1", range(3, 5), "   \n")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("new session", () => {
  it("opens with the quote and room to type under it", () => {
    expect(newSessionText(range(4, 4))).toBe("> /r/app/src/math.ts:L4\n> ```ts\n>   return a + b;\n> ```\n\n");
  });
});
