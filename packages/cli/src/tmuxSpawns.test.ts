import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexSessionFile, parseSessionFile, type ParsedMessage } from "./parser";
import { tmuxSpawns, TmuxSpawnRegistry } from "./tmuxSpawns";

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
