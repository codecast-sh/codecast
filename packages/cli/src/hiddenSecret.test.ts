import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promptHiddenSecret } from "./hiddenSecret.js";

describe("promptHiddenSecret off a tty", () => {
  test("takes the first line of what stdin holds", async () => {
    expect(await promptHiddenSecret("x", () => "  tok-1  \nsecond\n")).toBe("tok-1");
  });

  test("reads a secret redirected from a file (< key), as the CLI does", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hidden-secret-"));
    const key = path.join(dir, "key");
    fs.writeFileSync(key, "cc_tok_file\n");
    const script = path.join(dir, "read.ts");
    fs.writeFileSync(script, `import { promptHiddenSecret } from ${JSON.stringify(path.join(import.meta.dir, "hiddenSecret.ts"))};\nprocess.stdin.on("data", () => {});\nprocess.stdout.write(await promptHiddenSecret("p"));\n`);
    const fd = fs.openSync(key, "r");
    const out = Bun.spawnSync(["bun", script], { stdin: fd, stdout: "pipe", stderr: "pipe" });
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(out.stdout.toString()).toBe("cc_tok_file");
  });
});
