import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexModelBeforeOffset } from "./codexTranscriptModel";
import { parseCodexSessionFile } from "./parser";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("Codex incremental model attribution", () => {
  test("recovers the model before the ingest offset without reading a future switch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-model-"));
    dirs.push(dir);
    const path = join(dir, "rollout.jsonl");
    const prefix = JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }) + "\n"
      + JSON.stringify({ type: "response_item", payload: { content: "x".repeat(140000) } }) + "\n";
    const next = JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }) + "\n";
    await writeFile(path, prefix + next);
    expect(await readCodexModelBeforeOffset(path, 0)).toBeUndefined();
    expect(await readCodexModelBeforeOffset(path, Buffer.byteLength(prefix))).toBe("gpt-5.6-sol");
    expect(await readCodexModelBeforeOffset(path, Buffer.byteLength(prefix + next))).toBe("gpt-6-astra");
  });

  test("carries model context between transcript windows", () => {
    const state: { model?: string } = {};
    parseCodexSessionFile(JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } }), state);
    const [message] = parseCodexSessionFile(JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Continued" }] } }), state);
    expect(message.model).toBe("gpt-6-astra");
  });
});
