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
    // A clock that moves 10 ms each time it is read: a 15 ms budget runs out after one chunk, under any load.
    let t = 0;
    const clock = () => (t += 10);
    const first = attributeEdits(root, ["a.ts", "b.ts"], { since: 0, now, budgetMs: 15, clock });
    expect(first.partial).toBe(true);
    expect(first.owners.get("a.ts")).toBeUndefined();
    let last = first;
    let calls = 1;
    for (; calls < 20 && last.partial; calls++) last = attributeEdits(root, ["a.ts", "b.ts"], { since: 0, now, budgetMs: 15, clock });
    // More than one call to read 9 MB in 8 MB chunks, and few: each goes on from where the last stopped.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(6);
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
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "f.ts"), "x");
    const typed = root.replace(/^\/private/, "");
    expect(shellWrites(`echo y > ${typed}/f.ts`, typed, root)).toEqual(["f.ts"]);
  });
});

describe("a relative path is read from where the command stands when it names it", () => {
  const checkout = (name: string) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `attr-cd-${name}-`)));
    fs.mkdirSync(path.join(dir, ".git"));
    for (const f of ["packages/cli/src/index.ts", "packages/cli/src/pipeline.ts", "README.md"]) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), "x");
    }
    return dir;
  };

  test("a command that starts in one checkout and cds into another credits what it wrote in the other, never the first's files", async () => {
    const { shellWrites } = await import("./attribute");
    const main = checkout("main");
    const wt = checkout("wt");
    // The shape that told the wrong session: a python write in the worktree, then running the CLI from its root.
    const command = `cd ${wt}/packages/cli && python3 - <<'EOF'\np='src/pipeline.ts'\nopen(p,'w').write('y')\nEOF\ncd ${wt} && bun packages/cli/src/index.ts flow pipeline`;
    expect(shellWrites(command, main, main)).toEqual([]);
    // It wrote pipeline.ts; index.ts it only ran.
    expect(shellWrites(command, main, wt)).toEqual(["packages/cli/src/pipeline.ts"]);
  });

  test("where it did not cd, a relative path is the starting directory's; in a subdirectory, the checkout's root is tried too", async () => {
    const { shellWrites } = await import("./attribute");
    const main = checkout("main");
    expect(shellWrites("echo y > README.md", main, main)).toEqual(["README.md"]);
    expect(shellWrites("cd packages/cli && sed -i '' s/x/y/ src/index.ts", main, main)).toEqual(["packages/cli/src/index.ts"]);
    expect(shellWrites("cd packages/cli && sed -i '' s/x/y/ README.md", main, main)).toEqual(["README.md"]);
    // Running the CLI with its output in /tmp writes nothing in the checkout (jx71h73's dry run).
    expect(shellWrites(`bun ${main}/packages/cli/src/index.ts ship checkout --dry-run > /tmp/x.log`, main, main)).toEqual([]);
    expect(shellWrites("bun packages/cli/src/index.ts flow pipeline > /tmp/p.txt 2>&1", main, main)).toEqual([]);
    // A path through a file names nothing, and says so without throwing.
    expect(shellWrites("echo y > README.md/bun.lock", main, main)).toEqual([]);
  });
});
