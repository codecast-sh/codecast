import { describe, expect, test } from "bun:test";
import { LspFrameReader, encodeLspFrame } from "./framing.js";

function collect(maxBytes?: number) {
  const out = { messages: [] as string[], oversize: [] as number[], errors: [] as string[] };
  const reader = new LspFrameReader(
    { message: (m) => out.messages.push(m), oversize: (n) => out.oversize.push(n), error: (e) => out.errors.push(e) },
    maxBytes,
  );
  return { reader, out };
}

const MESSAGES = [
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  JSON.stringify({ jsonrpc: "2.0", method: "note", params: { text: "héllo wörld 🌍 日本語 ∆˙" } }),
  "",
  JSON.stringify({ jsonrpc: "2.0", id: "x", result: "🌍".repeat(300) }),
];
const STREAM = Buffer.concat(MESSAGES.map(encodeLspFrame));

describe("LspFrameReader", () => {
  test("many messages in one chunk", () => {
    const { reader, out } = collect();
    reader.push(STREAM);
    expect(out.messages).toEqual(MESSAGES);
  });

  test("split at every byte boundary, multi-byte characters included", () => {
    for (let cut = 1; cut < STREAM.length; cut++) {
      const { reader, out } = collect();
      reader.push(STREAM.subarray(0, cut));
      reader.push(STREAM.subarray(cut));
      expect(out.messages).toEqual(MESSAGES);
    }
  });

  test("one byte at a time", () => {
    const { reader, out } = collect();
    for (let i = 0; i < STREAM.length; i++) reader.push(STREAM.subarray(i, i + 1));
    expect(out.messages).toEqual(MESSAGES);
  });

  test("random chunk sizes over a long stream", () => {
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n) + 1;
    const many = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i, s: "ü😀".repeat(i % 17) }));
    const stream = Buffer.concat(many.map(encodeLspFrame));
    const { reader, out } = collect();
    for (let at = 0; at < stream.length; ) {
      const n = rand(97);
      reader.push(stream.subarray(at, at + n));
      at += n;
    }
    expect(out.messages).toEqual(many);
  });

  test("header names are case-insensitive and other headers are ignored", () => {
    const { reader, out } = collect();
    const body = '{"a":1}';
    reader.push(Buffer.from(`content-type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH:  ${body.length} \r\n\r\n${body}`));
    expect(out.messages).toEqual([body]);
  });

  test("an oversize body is skipped and the next message still arrives", () => {
    const { reader, out } = collect(16);
    const big = encodeLspFrame(JSON.stringify({ big: "x".repeat(100) }));
    const small = encodeLspFrame('{"ok":1}');
    const stream = Buffer.concat([big, small]);
    for (let i = 0; i < stream.length; i += 7) reader.push(stream.subarray(i, i + 7));
    expect(out.oversize).toEqual([big.length - big.indexOf("{")]);
    expect(out.messages).toEqual(['{"ok":1}']);
  });

  test("garbage without a Content-Length is an error, reported once", () => {
    const { reader, out } = collect();
    reader.push(Buffer.from("hello\r\n\r\n{}"));
    reader.push(encodeLspFrame("{}"));
    expect(out.errors).toEqual(["missing Content-Length"]);
    expect(out.messages).toEqual([]);
  });

  test("an endless header is an error rather than unbounded buffering", () => {
    const { reader, out } = collect();
    for (let i = 0; i < 10; i++) reader.push(Buffer.alloc(1024, 65));
    expect(out.errors).toEqual(["header too long"]);
  });
});
