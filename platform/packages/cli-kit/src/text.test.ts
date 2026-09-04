import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { clip, parseSince, readBody } from "./text";

const body = "Line one.\n\nLine two.\n";

/** Run readBody in a child whose stdin is `stdin`, after `process.stdin` has
 *  already been touched the way a prompt library does at import. */
async function readViaChild(stdin: ReturnType<typeof Bun.file> | "pipe", positional: string | undefined) {
  const script = `
    void process.stdin;
    await new Promise((r) => setTimeout(r, 30));
    const { readBody } = await import(${JSON.stringify(path.join(import.meta.dir, "text.ts"))});
    process.stdout.write(JSON.stringify(await readBody(${JSON.stringify(positional)}, {})));
  `;
  const proc = Bun.spawn(["bun", "-e", script], { stdin, stdout: "pipe", stderr: "pipe" });
  if (stdin === "pipe") {
    const input = proc.stdin as import("bun").FileSink;
    input.write(body);
    input.end();
  }
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(err).toBe("");
  return JSON.parse(out) as string;
}

describe("readBody", () => {
  test("positional wins over stdin", async () => {
    expect(await readBody("hello", {})).toBe("hello");
  });

  test("--body-file reads the file verbatim", async () => {
    const file = path.join(os.tmpdir(), `cli-kit-body-${process.pid}.txt`);
    fs.writeFileSync(file, body);
    expect(await readBody(undefined, { bodyFile: file })).toBe(body);
    fs.unlinkSync(file);
  });

  test("stdin from a file keeps every line, even after the stream was touched", async () => {
    const file = path.join(os.tmpdir(), `cli-kit-stdin-${process.pid}.txt`);
    fs.writeFileSync(file, body);
    expect(await readViaChild(Bun.file(file), "-")).toBe("Line one.\n\nLine two.");
    expect(await readViaChild(Bun.file(file), undefined)).toBe("Line one.\n\nLine two.");
    fs.unlinkSync(file);
  });

  test("stdin from a pipe keeps every line", async () => {
    expect(await readViaChild("pipe", "-")).toBe("Line one.\n\nLine two.");
  });
});

describe("clip", () => {
  test("flattens whitespace and clips with an ellipsis", () => {
    expect(clip("a  b\n\nc", 10)).toBe("a b c");
    expect(clip("abcdefghijk", 5)).toBe("abcd…");
  });
});

describe("parseSince", () => {
  test("durations and dates", () => {
    const now = 1_000_000_000_000;
    expect(parseSince("3d", now)).toBe(now - 3 * 86_400_000);
    expect(parseSince("nonsense", now)).toBeNull();
  });
});
