import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const start = source.indexOf('if (resumeAgentType === "codex" && (parsed.fork === true || forceReconstitute) && conversationId)');
const end = source.indexOf("} catch (forkErr)", start);
const importer = source.slice(start, end);

describe("Codex fork import identity", () => {
  test("uses a native UUID for temporary metadata, not the virtual conversation session id", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(importer).toContain("generateCodexJsonl(exportData, { sessionId: randomUUID() })");
    expect(importer).toContain('writeCodexSession(jsonl, importSessionId, "codecast-fork")');
    expect(importer).not.toContain("generateCodexJsonl(exportData, { sessionId })");
  });

  test("keeps temporary import provenance separate from the final conversation binding", () => {
    expect(importer).toContain("pendingAppServerForkParents.add(importSessionId)");
    expect(importer).toContain("pendingForkParentId = importSessionId");
    expect(importer).toContain("path: importPath");
    expect(importer).toContain("const realThreadId = forked.thread.id");
    expect(importer).toContain("remapConversationSession(sessionId, realThreadId, conversationId)");
    expect(importer).toContain("pushSessionIdBinding(conversationId, realThreadId, cwd");
  });
});
