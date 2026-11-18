import { describe, expect, test } from "bun:test";
import { rebuiltSessionFile } from "./daemon";

describe("rebuiltSessionFile", () => {
  const written = "/home/u/.claude/projects/-home-u/3800b3f5.jsonl";
  const exists = (p: string) => p === written;

  test("an agent switch resumes the transcript it wrote, not the old agent's file under the same id", () => {
    const grok = { path: "/home/u/.grok/sessions/3800b3f5/messages.jsonl", agentType: "grok" as const };
    expect(rebuiltSessionFile(grok, written, "claude", exists)).toEqual({ path: written, agentType: "claude" });
  });

  test("a lookup that already names the rebuilt agent's file is kept", () => {
    const found = { path: "/elsewhere/3800b3f5.jsonl", agentType: "claude" as const };
    expect(rebuiltSessionFile(found, written, "claude", exists)).toBe(found);
  });

  test("nothing on disk resumes nothing", () => {
    expect(rebuiltSessionFile(null, "", "opencode", exists)).toBeNull();
    expect(rebuiltSessionFile(null, "/missing.jsonl", "claude", exists)).toBeNull();
  });
});
