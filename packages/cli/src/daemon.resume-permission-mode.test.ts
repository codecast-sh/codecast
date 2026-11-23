import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildClaudeResumeCommand } from "./daemon.js";
import { extractJsonlPermissionMode } from "./resumeCommand.js";

const dir = mkdtempSync(join(tmpdir(), "resume-permission-mode-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const user = (permissionMode?: string) =>
  JSON.stringify({ type: "user", ...(permissionMode && { permissionMode }), message: { role: "user", content: "hi" } });
const modeChange = (permissionMode: string) => JSON.stringify({ type: "permission-mode", permissionMode });

async function resumeCmd(lines: string[], extra: { permissionMode?: string; config?: Record<string, unknown> | null; headOnly?: boolean } = {}) {
  const jsonlPath = join(dir, "t.jsonl");
  writeFileSync(jsonlPath, lines.join("\n"));
  const jsonlContent = extra.headOnly ? lines[0] : lines.join("\n");
  const { resumeCmd } = await buildClaudeResumeCommand({
    sessionId: "11111111-2222-3333-4444-555555555555", cwd: dir, jsonlPath, jsonlContent,
    config: (extra.config ?? null) as never, permissionMode: extra.permissionMode,
  });
  return resumeCmd;
}

describe("extractJsonlPermissionMode reads the latest mode", () => {
  test("a later user line wins over the first", () => {
    expect(extractJsonlPermissionMode([user("bypassPermissions"), user("auto")].join("\n"))).toBe("auto");
  });
  test("a later permission-mode line wins over the first user line", () => {
    expect(extractJsonlPermissionMode([user("bypassPermissions"), modeChange("plan")].join("\n"))).toBe("plan");
  });
  test("lines without a mode do not erase the last one seen", () => {
    expect(extractJsonlPermissionMode([user("auto"), user()].join("\n"))).toBe("auto");
  });
});

describe("a resume keeps the mode the session ended in", () => {
  test("first line bypass, latest auto: resumes in auto", async () => {
    const cmd = await resumeCmd([user("bypassPermissions"), user("auto")]);
    expect(cmd).toContain("--permission-mode auto");
    expect(cmd).not.toContain("--dangerously-skip-permissions");
  });
  test("a latest mode beyond the head the daemon reads still wins", async () => {
    const cmd = await resumeCmd([user("bypassPermissions"), user("auto")], { headOnly: true });
    expect(cmd).toContain("--permission-mode auto");
  });
  test("bypass throughout: unchanged, --dangerously-skip-permissions", async () => {
    const cmd = await resumeCmd([user("bypassPermissions"), user("bypassPermissions")]);
    expect(cmd).toContain("--dangerously-skip-permissions");
    expect(cmd).not.toContain("--permission-mode");
  });
  test("no recorded mode: the machine default", async () => {
    expect(await resumeCmd([user()])).toContain("--permission-mode bypassPermissions");
  });
  test("a mode the backend reported still wins over the transcript", async () => {
    const cmd = await resumeCmd([user("bypassPermissions"), user("auto")], { permissionMode: "plan" });
    expect(cmd).toContain("--permission-mode plan");
    expect(cmd).not.toContain("--permission-mode auto");
  });
  test("claude_args keeps precedence over the transcript's latest mode", async () => {
    const cmd = await resumeCmd([user("bypassPermissions"), user("auto")], { config: { claude_args: "--permission-mode acceptEdits" } });
    expect(cmd).toContain("--permission-mode acceptEdits");
    expect(cmd).not.toContain("--permission-mode auto");
  });
});
