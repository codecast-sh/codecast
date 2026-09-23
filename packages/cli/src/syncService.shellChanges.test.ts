import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SyncService } from "./syncService.js";
import { shellChangesDir } from "./shellChanges.js";

// A Bash call the shell-changes hook recorded rides the message that carries
// its tool result as file_changes, and the record is forgotten once the batch
// lands. The blobs come from a real repository, as they do in production.
let home: string;
let repo: string;
const savedHome = process.env.HOME;

function blob(content: string): string {
  return execFileSync("git", ["-C", repo, "hash-object", "-w", "--stdin"], { input: content, encoding: "utf-8" }).trim();
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-sync-shell-"));
  process.env.HOME = home;
  repo = path.join(home, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  fs.mkdirSync(shellChangesDir(home), { recursive: true });
  const before = blob("one\n");
  const after = blob("one\ntwo\n");
  const gone = blob("bye\n");
  fs.writeFileSync(path.join(shellChangesDir(home), "toolu_x"), [
    `root\t${repo}`,
    `${before}\t${after}\tsrc/a.ts`,
    `${gone}\t0\tsrc/gone.ts`,
    `0\t${after}\tsrc/new.ts`,
    "",
  ].join("\n"));
});

afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("addMessages carries recorded shell changes", () => {
  it("attaches them to the tool result's message and discards the record once the batch lands", async () => {
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    const sent: any[] = [];
    (sync as any).client = { mutation: async (_name: unknown, args: any) => { sent.push(args); return { inserted: args.messages.length, ids: ["m"] }; } };
    (sync as any).throttle = async () => {};

    await sync.addMessages({
      conversationId: "conv",
      messages: [
        { role: "assistant", content: "", timestamp: 1, toolCalls: [{ id: "toolu_x", name: "Bash", input: { command: "sed -i ..." } }] },
        { role: "human", content: "", timestamp: 2, toolResults: [{ toolUseId: "toolu_x", content: "ok" }] },
        { role: "human", content: "", timestamp: 3, toolResults: [{ toolUseId: "toolu_other", content: "ok" }] },
      ],
    });

    expect(sent).toHaveLength(1);
    const [call, result, other] = sent[0].messages;
    expect(call.file_changes).toBeUndefined();
    expect(other.file_changes).toBeUndefined();
    expect(result.file_changes).toEqual([
      { tool_call_id: "toolu_x", seq: 0, file_path: path.join(repo, "src/a.ts"), change_type: "write", old_content: "one\n", new_content: "one\ntwo\n" },
      { tool_call_id: "toolu_x", seq: 1, file_path: path.join(repo, "src/gone.ts"), change_type: "delete", old_content: "bye\n", new_content: "" },
      { tool_call_id: "toolu_x", seq: 2, file_path: path.join(repo, "src/new.ts"), change_type: "write", old_content: undefined, new_content: "one\ntwo\n" },
    ]);
    expect(fs.existsSync(path.join(shellChangesDir(home), "toolu_x"))).toBe(false);
  });

  it("keeps the record when the upload fails, so a retry carries it again", async () => {
    fs.writeFileSync(path.join(shellChangesDir(home), "toolu_y"), `root\t${repo}\n${blob("a\n")}\t${blob("b\n")}\tf.ts\n`);
    const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "u", authToken: "t" });
    (sync as any).client = { mutation: async () => { throw new Error("offline"); } };
    (sync as any).throttle = async () => {};
    await sync.addMessages({
      conversationId: "conv",
      messages: [{ role: "human", content: "", timestamp: 2, toolResults: [{ toolUseId: "toolu_y", content: "ok" }] }],
    }).catch(() => {});
    expect(fs.existsSync(path.join(shellChangesDir(home), "toolu_y"))).toBe(true);
  });
});
