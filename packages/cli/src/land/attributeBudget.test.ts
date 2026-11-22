// The daemon reads transcripts for its checkout report a little each pass (attribute.ts budgetMs): a long session's
// transcript runs to hundreds of MB and the read is synchronous. A budget leaves the result partial and the cache
// where it stopped; the next call goes on from there and ends with what one unbudgeted read finds. Synthetic only.
import { beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { attributeEdits } from "./attribute";
import { updateSyncRecord } from "../syncLedger";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir";
isolateCodecastDirEachTest("cast-attr-budget-");

let root: string;
let dir: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "attr-budget-root-")));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "attr-budget-transcripts-"));
});

const edit = (file: string, at: number) => JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), cwd: root, message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: path.join(root, file) } }] } });
const filler = (n: number) => JSON.stringify({ type: "user", message: { role: "user", content: "x".repeat(n) } });

function transcript(name: string, lines: string[], conversation: string): string {
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  updateSyncRecord(file, { conversationId: conversation });
  return file;
}

describe("attribution under a budget", () => {
  test("a budget that runs out leaves the result partial; reading on finds the last writer one read would", () => {
    const now = Date.now();
    // 9 MB of turns before the edit: more than one chunk, so a short budget stops inside the file.
    transcript("long", [...Array.from({ length: 9 }, () => filler(1024 * 1024)), edit("a.ts", now - 1000)], "conv_long");
    transcript("short", [edit("b.ts", now - 2000)], "conv_short");
    const first = attributeEdits(root, ["a.ts", "b.ts"], { since: 0, now, budgetMs: 1 });
    expect(first.partial).toBe(true);
    expect(first.owners.get("a.ts")).toBeUndefined();
    let last = first;
    for (let i = 0; i < 10 && last.partial; i++) last = attributeEdits(root, ["a.ts", "b.ts"], { since: 0, now, budgetMs: 1 });
    expect(last.partial).toBeUndefined();
    expect(last.owners.get("a.ts")?.conversationId).toBe("conv_long");
    expect(last.owners.get("b.ts")?.conversationId).toBe("conv_short");
    // Done: an unbudgeted read agrees, and reads nothing it has not read.
    const whole = attributeEdits(root, ["a.ts", "b.ts"], { since: 0, now });
    expect(whole.scanned).toBe(0);
    expect([...whole.owners].map(([p, s]) => [p, s.conversationId])).toEqual([...last.owners].map(([p, s]) => [p, s.conversationId]));
  });

  test("with no budget a read is whole, as cast ship checkout reads", () => {
    const now = Date.now();
    transcript("one", [filler(100), edit("a.ts", now - 10)], "conv_one");
    const a = attributeEdits(root, ["a.ts"], { since: 0, now });
    expect(a.partial).toBeUndefined();
    expect(a.owners.get("a.ts")?.conversationId).toBe("conv_one");
  });
});

describe("paths on other volumes are never touched on disk", () => {
  test("other volumes and remote hosts' paths credit nothing and return at once", async () => {
    const { shellWrites } = await import("./attribute");
    const t = Date.now();
    expect(shellWrites(`cd "/Volumes/Archive/Photos Library" && find originals > /private/tmp/oa.txt; echo x > /home/ubuntu/work/app/out.txt; cd /net/host/share && touch y.txt`, "/", root)).toEqual([]);
    expect(Date.now() - t).toBeLessThan(200);
  });

  test("a checkout written through macOS's /tmp link is still the checkout", async () => {
    const { shellWrites } = await import("./attribute");
    if (!root.startsWith("/private/tmp/") && !root.startsWith("/private/var/")) return;
    fs.writeFileSync(path.join(root, "f.ts"), "x");
    const typed = root.replace(/^\/private/, "");
    expect(shellWrites(`echo y > ${typed}/f.ts`, typed, root)).toEqual(["f.ts"]);
  });
});
