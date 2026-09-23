import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CODECAST_SHELL_CHANGES_HOOK } from "./shellChangesHook.js";
import { discardShellChanges, parseShellChangesFile, readShellChanges, shellChangesDir } from "./shellChanges.js";

// Run the installed hook exactly as Claude Code would around a Bash call: pipe
// the PreToolUse payload, change files on disk the way a shell command would,
// pipe the PostToolUse payload, then read back what the daemon would attach.
let home: string;
let repo: string;
let hookFile: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

function runHook(payload: Record<string, unknown>): void {
  execFileSync("bash", [hookFile], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOME: home },
  });
}

function bashCall(id: string, event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure", extra: Record<string, unknown> = {}) {
  runHook({
    session_id: "s-1",
    hook_event_name: event,
    tool_name: "Bash",
    tool_use_id: id,
    cwd: repo,
    tool_input: { command: "sed -i '' s/a/b/ file.ts", description: "edit" },
    ...extra,
  });
}

function sidecar(id: string): string {
  return path.join(shellChangesDir(home), id);
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-shell-hook-"));
  hookFile = path.join(home, "codecast-shell-changes.sh");
  fs.writeFileSync(hookFile, CODECAST_SHELL_CHANGES_HOOK, { mode: 0o755 });
  repo = path.join(home, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "src", "clean.ts"), "one\ntwo\nthree\n");
  fs.writeFileSync(path.join(repo, "src", "dirty.ts"), "committed\n");
  fs.writeFileSync(path.join(repo, "src", "gone.ts"), "to be removed\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  // Already modified before the call, as another session's work would be.
  fs.writeFileSync(path.join(repo, "src", "dirty.ts"), "committed\nchanged earlier\n");
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("codecast-shell-changes hook", () => {
  test("a read-only call records nothing", async () => {
    bashCall("toolu_read", "PreToolUse");
    bashCall("toolu_read", "PostToolUse");
    expect(fs.existsSync(sidecar("toolu_read"))).toBe(false);
    expect(await readShellChanges("toolu_read", shellChangesDir(home))).toBeNull();
    // The pre listing is consumed either way.
    expect(fs.readdirSync(path.join(shellChangesDir(home), "pre"))).toEqual([]);
  });

  test("edits, additions and removals made by the command are recorded with exact before/after text", async () => {
    bashCall("toolu_edit", "PreToolUse");
    // What a shell command does: rewrite a clean file, extend an already-dirty
    // file, create a new one, delete a tracked one, touch an ignored one.
    fs.writeFileSync(path.join(repo, "src", "clean.ts"), "one\n2\nthree\n");
    fs.writeFileSync(path.join(repo, "src", "dirty.ts"), "committed\nchanged earlier\nchanged now\n");
    fs.writeFileSync(path.join(repo, "src", "new.ts"), "brand new\n");
    fs.unlinkSync(path.join(repo, "src", "gone.ts"));
    fs.writeFileSync(path.join(repo, "ignored.log"), "noise\n");
    bashCall("toolu_edit", "PostToolUse");

    const text = fs.readFileSync(sidecar("toolu_edit"), "utf-8");
    const parsed = parseShellChangesFile(text)!;
    expect(parsed.root).toBe(fs.realpathSync(repo));
    expect(parsed.entries.map((e) => e.path)).toEqual(["src/clean.ts", "src/dirty.ts", "src/gone.ts", "src/new.ts"]);

    const changes = (await readShellChanges("toolu_edit", shellChangesDir(home)))!;
    const byPath = Object.fromEntries(changes.map((c) => [path.relative(fs.realpathSync(repo), c.file_path), c]));
    // Clean before the call: the old text is what HEAD held.
    expect(byPath["src/clean.ts"]).toMatchObject({ change_type: "write", old_content: "one\ntwo\nthree\n", new_content: "one\n2\nthree\n" });
    // Dirty before the call: the old text is the dirty text, not HEAD's.
    expect(byPath["src/dirty.ts"]).toMatchObject({ change_type: "write", old_content: "committed\nchanged earlier\n", new_content: "committed\nchanged earlier\nchanged now\n" });
    expect(byPath["src/new.ts"]).toMatchObject({ change_type: "write", new_content: "brand new\n" });
    expect(byPath["src/new.ts"].old_content).toBeUndefined();
    expect(byPath["src/gone.ts"]).toMatchObject({ change_type: "delete", old_content: "to be removed\n", new_content: "" });
    expect(byPath["ignored.log"]).toBeUndefined();
    expect(changes.every((c) => c.tool_call_id === "toolu_edit")).toBe(true);
    expect(changes.map((c) => c.seq)).toEqual([0, 1, 2, 3]);

    discardShellChanges(["toolu_edit"], shellChangesDir(home));
    expect(fs.existsSync(sidecar("toolu_edit"))).toBe(false);
  });

  test("a commit inside the call is not a file change, and the next call's baseline is the new HEAD", async () => {
    bashCall("toolu_commit", "PreToolUse");
    git("add", "-A");
    git("commit", "-q", "-m", "work");
    bashCall("toolu_commit", "PostToolUse");
    expect(fs.existsSync(sidecar("toolu_commit"))).toBe(false);

    bashCall("toolu_after", "PreToolUse");
    fs.writeFileSync(path.join(repo, "src", "new.ts"), "brand new\nplus\n");
    bashCall("toolu_after", "PostToolUseFailure");
    const changes = (await readShellChanges("toolu_after", shellChangesDir(home)))!;
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ change_type: "write", old_content: "brand new\n", new_content: "brand new\nplus\n" });
  });

  test("a call the hook cannot name, or outside a repository, records nothing", () => {
    bashCall("", "PreToolUse");
    bashCall("../evil", "PreToolUse");
    runHook({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_norepo", cwd: os.tmpdir() });
    runHook({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_read_tool", cwd: repo });
    expect(fs.readdirSync(path.join(shellChangesDir(home), "pre"))).toEqual([]);
    expect(fs.existsSync(path.join(home, "evil"))).toBe(false);
  });
});
