import { expect, test } from "bun:test";
import { extractMessages } from "../parser";
import { validateIngestResult } from "./ingestValidation";
import type { IngestJob } from "./ingestTypes";

const job: IngestJob = { client: "claude", file: "/owned/source", sessionId: "full-session", generation: "generation", offset: 0, identity: { dev: 1, ino: 2, birthtimeMs: 3, ctimeMs: 4, mtimeMs: 5, size: 100 } };

function parsedResult(role: "user" | "assistant", usage?: unknown) {
  const messages = extractMessages([{
    type: role,
    uuid: "message-id",
    timestamp: "2026-09-13T19:12:00.000Z",
    message: { role, content: "original follow-up", model: "claude-opus-4-6", usage },
  } as any]);
  return { messages, bytesConsumed: 100, fileSize: 100, totalCount: messages.length, maxRowId: 0, signatures: ["a".repeat(64)], receiptSignatures: ["b".repeat(64)], receiptOccurrences: [0], messageTitles: [null], handoffParents: [null], metadata: { warnings: [], headMessages: messages } };
}

test("actual parser output crosses ingestion with and without token usage", async () => {
  for (const role of ["user", "assistant"] as const) {
    for (const usage of [undefined, { input_tokens: 3, output_tokens: 5 }, { input_tokens: 0, output_tokens: 5, cache_creation_input_tokens: 9, cache_read_input_tokens: 21 }]) {
      const result = parsedResult(role, usage);
      expect(result.messages).toHaveLength(1);
      await expect(validateIngestResult(result, job)).resolves.toEqual(result);
      if (role === "assistant" && usage) expect(result.messages[0].usage).toEqual(usage);
    }
  }
});

test("malformed token usage cannot cross ingestion", async () => {
  for (const usage of [null, [], "3", {}, { input_tokens: 3 }, { input_tokens: "3", output_tokens: 5 }, { input_tokens: -1, output_tokens: 5 }, { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: "21" }, { input_tokens: 3, output_tokens: 5, unexpected: true }]) {
    const result = parsedResult("assistant");
    (result.messages[0] as any).usage = usage;
    await expect(validateIngestResult(result, job)).rejects.toThrow("invalid ingest");
  }
});
