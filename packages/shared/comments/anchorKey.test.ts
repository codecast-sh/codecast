import { describe, expect, test } from "bun:test";
import {
  codeAnchorKey,
  codeThreadRootKey,
  parseCodeThreadRootKey,
  commentAnchorKey,
  commentThreadRootKey,
  parseCommentThreadRootKey,
  webThreadKeyFromAnchor,
} from "./anchorKey";

describe("comment anchor keys", () => {
  test("one key per anchor kind", () => {
    expect(commentAnchorKey({ message_id: "m1" })).toBe("msg:m1");
    expect(commentAnchorKey({ file_path: "src/a.ts", line_number: 12 })).toBe("file:src/a.ts:12");
    expect(commentAnchorKey({ file_path: "src/a.ts" })).toBe("file:src/a.ts:");
    expect(commentAnchorKey({})).toBe("global");
    // A message anchor wins over a stray file path.
    expect(commentAnchorKey({ message_id: "m1", file_path: "x" })).toBe("msg:m1");
  });

  test("the root key round-trips through the FIRST colon", () => {
    const key = commentThreadRootKey("conv1", { file_path: "a:b.ts", line_number: 3 });
    expect(key).toBe("conv1:file:a:b.ts:3");
    expect(parseCommentThreadRootKey(key)).toEqual({ conversationId: "conv1", anchorKey: "file:a:b.ts:3" });
    expect(parseCommentThreadRootKey("conv1")).toEqual({ conversationId: "conv1", anchorKey: "global" });
  });

  test("the web thread key strips only the msg: prefix", () => {
    expect(webThreadKeyFromAnchor("msg:m1")).toBe("m1");
    expect(webThreadKeyFromAnchor("file:a.ts:1")).toBe("file:a.ts:1");
    expect(webThreadKeyFromAnchor("global")).toBe("global");
  });
});

describe("code thread root keys", () => {
  test("names a line of a file at a ref, and the ref itself", () => {
    expect(codeAnchorKey({ file_path: "src/a.ts", line_number: 12 })).toBe("file:src/a.ts:12");
    expect(codeAnchorKey({})).toBe("global");
    expect(codeThreadRootKey("o/r", "abc123", { file_path: "src/a.ts", line_number: 12 })).toBe("o/r@abc123#file:src/a.ts:12");
    expect(codeThreadRootKey("o/r", "abc123", {})).toBe("o/r@abc123#global");
  });
  test("parses back what it wrote, including paths with @ and : in them", () => {
    const key = codeThreadRootKey("o/r", "abc123", { file_path: "pkg/@scope/x:y.ts", line_number: 7 });
    expect(parseCodeThreadRootKey(key)).toEqual({
      repository: "o/r",
      ref: "abc123",
      anchorKey: "file:pkg/@scope/x:y.ts:7",
      filePath: "pkg/@scope/x:y.ts",
      lineNumber: 7,
    });
    expect(parseCodeThreadRootKey("o/r@abc123#global")).toEqual({ repository: "o/r", ref: "abc123", anchorKey: "global" });
  });
});
