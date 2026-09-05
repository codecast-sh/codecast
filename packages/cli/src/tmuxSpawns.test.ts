import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { parseCodexSessionFile, parseSessionFile, type ParsedMessage } from "./parser";
import { registerAppServerSpawnTracking, tmuxSpawns, TmuxSpawnRegistry } from "./tmuxSpawns";

const timestamp = "2026-09-05T00:54:59.202Z";
const startedAt = Date.parse(timestamp);
const shell = (command: string): ParsedMessage[] => [{ role: "assistant", content: "", timestamp: startedAt, toolCalls: [{ id: "launch", name: "Bash", input: { command } }] }];

test("Codex exec recovers both actual launches, skipping prompt heredocs", () => {
  const command = "cat > /tmp/review.prompt <<'EOF'\nExample:\ntmux new -s example\nEOF\ntmux new-session -d -s ports 'codex exec - < /tmp/ports.prompt'; tmux new-session -d -s review 'codex exec - < /tmp/review.prompt'";
  const source = `text(await tools.exec_command({cmd:${JSON.stringify(command)},max_output_tokens:1000}));`;
  const messages = parseCodexSessionFile(JSON.stringify({ type: "response_item", timestamp, payload: { type: "custom_tool_call", name: "exec", call_id: "launch", input: source } }));
  expect(tmuxSpawns(messages)).toEqual([{ name: "ports", timestamp: startedAt }, { name: "review", timestamp: startedAt }]);
});

test("Claude launches support aliases, quotes, batches and agent-spawn", () => {
  const messages = parseSessionFile(JSON.stringify({ type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "tool_use", id: "launch", name: "Bash", input: { command: "cd /repo && tmux new -d -s 'review-one' 'codex exec test'; agent-spawn.sh implementor review-two /repo" } }] } }));
  expect(tmuxSpawns(messages).map(s => s.name)).toEqual(["review-one", "review-two"]);
});

test("quoted examples, comments, user text and dynamic names are not launches", () => {
  expect(tmuxSpawns(shell("echo 'tmux new-session -s fake'\n# tmux new -s comment\ntmux new -s \"$DYNAMIC\""))).toEqual([]);
  expect(tmuxSpawns([{ ...shell("tmux new -s fake")[0], role: "user" }])).toEqual([]);
  expect(tmuxSpawns(shell("tmux new -s `whoami`"))).toEqual([]);
});

test("Codex commandExecution unwraps login shells and skips the brief heredoc", () => {
  const command = "/bin/bash -lc \"cat > /tmp/brief.md <<'EOF'\ntmux new -s example\nEOF\ntmux new-session -d -s growth-conversion-check -c /repo\ntmux send-keys -t growth-conversion-check -- 'codex exec - < /tmp/brief.md' Enter\"";
  const messages = shell(command);
  messages[0].toolCalls![0].name = "commandExecution";
  expect(tmuxSpawns(messages)).toEqual([{ name: "growth-conversion-check", timestamp: startedAt }]);
  expect(tmuxSpawns(shell("/bin/zsh -lc 'bash -c \"tmux new -s nested\"'")).map(s => s.name)).toEqual(["nested"]);
  expect(tmuxSpawns(shell("echo '/bin/bash -lc \"tmux new -s example\"'"))).toEqual([]);
  expect(tmuxSpawns(shell("bash /tmp/script.sh -c 'tmux new -s example'"))).toEqual([]);
});

test("agent-spawn runtime and model options preserve the actual tmux session name", () => {
  for (const options of ["--codex", "--claude", "--runtime codex --model model", "--runtime=codex --model=model", "--"]) {
    expect(tmuxSpawns(shell(`/bin/bash -lc '/home/me/agent-spawn.sh ${options} reviewer growth-conversion-audit /repo brief'`)).map(s => s.name)).toEqual(["growth-conversion-audit"]);
  }
  for (const options of ["--dry-run", "--help", "-h", "--unknown", "--runtime --codex", "--model --codex"]) {
    expect(tmuxSpawns(shell(`agent-spawn.sh ${options} reviewer not-launched /repo`))).toEqual([]);
  }
});

test("syntax-only shells cannot replace the real launch parent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cast-tmux-noexec-"));
  try {
    const registry = new TmuxSpawnRegistry(join(dir, "spawns.json"));
    registry.record(shell("/bin/bash -elc 'tmux new -s worker'"), "real-parent");
    for (const command of [
      "bash -nc 'tmux new -s worker'",
      "bash -n -c 'tmux new -s worker'",
      "bash -lcn 'tmux new -s worker'",
      "/bin/bash -lc 'bash -nc \"tmux new -s worker\"'",
      "bash -o noexec -c 'tmux new -s worker'",
      "bash -o -c 'tmux new -s worker'",
      "zsh --noexec -c 'tmux new -s worker'",
    ]) {
      const messages = shell(command);
      messages[0].timestamp++;
      expect(tmuxSpawns(messages)).toEqual([]);
      expect(registry.record(messages, "syntax-check-parent")).toEqual([]);
      expect(registry.parentForPanes("worker 100", [101, 100], startedAt + 2)).toBe("real-parent");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("app-server records a launch at item start, before the command completes", async () => {
  const server = new EventEmitter();
  const launches: string[] = [];
  const errors: unknown[] = [];
  registerAppServerSpawnTracking(server, id => id === "parent-thread" ? "parent-conversation" : undefined, async (messages, parent) => {
    expect(parent).toBe("parent-conversation");
    launches.push(...tmuxSpawns(messages).map(s => s.name));
  }, err => errors.push(err));
  const item = { type: "commandExecution", id: "launch", status: "inProgress", command: "/bin/bash -lc 'tmux new -s worker'", cwd: "/repo" };
  server.emit("itemStarted", "unrelated", "turn", item);
  expect(launches).toEqual([]);
  server.emit("itemStarted", "parent-thread", "turn", item);
  expect(launches).toEqual(["worker"]);
  server.emit("itemCompleted", "parent-thread", "turn", { ...item, status: "completed" });
  expect(launches).toEqual(["worker"]);
  expect(errors).toEqual([]);

  const failedServer = new EventEmitter();
  registerAppServerSpawnTracking(failedServer, () => "parent", async () => { throw new Error("write failed"); }, err => errors.push(err));
  failedServer.emit("itemStarted", "parent-thread", "turn", item);
  await Promise.resolve();
  expect(errors).toHaveLength(1);
});

test("launch survives restart and resolves through the child pane ancestry", () => {
  const dir = mkdtempSync(join(tmpdir(), "cast-tmux-spawns-"));
  try {
    const file = join(dir, "spawns.json");
    const registry = new TmuxSpawnRegistry(file);
    registry.record(shell("tmux new -s review 'codex exec test'"), "parent");
    const restored = new TmuxSpawnRegistry(file);
    expect(restored.parentForPanes("review 100\nother 200", [103, 102, 100], startedAt + 2000)).toBe("parent");
    expect(restored.parentForPanes("review 100\nother 200", [203, 200], startedAt + 2000)).toBeUndefined();
    expect(restored.parent("review", startedAt - 1)).toBeUndefined();
    expect(restored.parent("review", startedAt + 24 * 60 * 60_000)).toBeUndefined();
    restored.record(shell("tmux new -s review 'codex exec test'"), "parent");
    expect(restored.parent("review", startedAt + 2000)).toBe("parent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
