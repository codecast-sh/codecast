// Files a `cast` command writes for a session are that session's change (writeLedger.ts): `cast flow edit` writes the
// project's flow and its prompt files, and `cast flow run` right after must find them as the session's own, with no
// --only. The first dogfood run (jx7bckk) found "No uncommitted change ... was written by session" instead.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { readSessionWrites, recordSessionWrites, writeLedgerFile } from "./writeLedger";
import { attributeEdits } from "./attribute";
import { applyFlowEdit, planFlowEdit } from "../flowEdit";
import { previewSessionChange } from "../workflow/flowChange";
import { isolateCodecastDirEachTest } from "../test-helpers/codecastDir";
isolateCodecastDirEachTest("cast-write-ledger-");

const SESSION = "6f1c2d3e-aaaa-bbbb-cccc-000000000001";
const AGENT = { CLAUDE_CODE_SESSION_ID: SESSION };

let root: string;
const git = (...args: string[]) => {
  // Commits are an hour old, so every write a test makes comes after the commit it is compared against.
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 3_600_000).toISOString(), GIT_AUTHOR_DATE: new Date(Date.now() - 3_600_000).toISOString() } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "write-ledger-")));
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "x\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("the session write ledger", () => {
  test("records a session's writes inside the checkout, under the session its env names, and nothing for a person's shell", () => {
    const file = path.join(root, ".codecast/flows/change.cast");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");
    expect(recordSessionWrites(root, [file, "/elsewhere/x.ts"], { env: AGENT, now: 5 })).toEqual([{ root, path: ".codecast/flows/change.cast", at: 5, session: SESSION }]);
    expect(recordSessionWrites(root, [file], { env: {} })).toEqual([]);
    expect(readSessionWrites(root, 0)).toEqual([{ root, path: ".codecast/flows/change.cast", at: 5, session: SESSION }]);
    expect(readSessionWrites(root, 6)).toEqual([]);
    expect(fs.existsSync(writeLedgerFile())).toBe(true);
  });

  test("a session named by the caller (cast flow run's callingSession) wins over the env; a codecast id is its conversation", () => {
    fs.writeFileSync(path.join(root, "b.ts"), "x");
    expect(recordSessionWrites(root, [path.join(root, "b.ts")], { session: "jx7bckkabcd", env: AGENT, now: 3 })).toEqual([{ root, path: "b.ts", at: 3, session: "jx7bckkabcd", conversation: "jx7bckkabcd" }]);
  });

  test("a deleted file is still credited, so an undo's removal is the session's too", () => {
    const gone = path.join(root, ".codecast/flows/change/review.guide.md");
    expect(recordSessionWrites(root, [gone], { env: { ...AGENT, CODECAST_CONVERSATION_ID: "jx7abcdefg" }, now: 9 })).toEqual([{ root, path: ".codecast/flows/change/review.guide.md", at: 9, session: SESSION, conversation: "jx7abcdefg" }]);
  });

  test("attribution credits a ledgered write to its session, even with no transcript of it", () => {
    fs.writeFileSync(path.join(root, "a.ts"), "x");
    recordSessionWrites(root, [path.join(root, "a.ts")], { env: { ...AGENT, CODECAST_CONVERSATION_ID: "jx7abcdefg" }, now: Date.now() });
    const a = attributeEdits(root, ["a.ts", "README.md"], { since: 0 });
    expect(a.owners.get("a.ts")).toMatchObject({ sessionId: SESSION, conversationId: "jx7abcdefg" });
    expect(a.owners.has("README.md")).toBe(false);
  });
});

describe("cast flow run right after cast flow edit", () => {
  const edit = (req: Parameters<typeof planFlowEdit>[2]) => applyFlowEdit(planFlowEdit(root, "change", req), { env: AGENT });

  test("the files an edit wrote are the session's change, with no --only", async () => {
    edit({ op: "add", station: "lint", after: "pr", run: "bun run lint" });
    edit({ op: "guide", station: "review", text: "Also check the migrations." });
    const change = await previewSessionChange(root, SESSION);
    expect(change.paths).toEqual([".codecast/flows/change.cast", ".codecast/flows/change/review.guide.md"]);
  });

  test("an undo's writes and removals are the session's change too", async () => {
    edit({ op: "guide", station: "review", text: "Also check the migrations." });
    edit({ op: "skip", station: "decide" });
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "flow edits");
    edit({ op: "undo", station: "review" });
    const change = await previewSessionChange(root, SESSION);
    expect(change.paths).toEqual([".codecast/flows/change.cast", ".codecast/flows/change/review.guide.md"]);
  });

  test("an edit from a person's shell names no session, so it is nobody's change", async () => {
    applyFlowEdit(planFlowEdit(root, "change", { op: "skip", station: "decide" }), { env: {} });
    await expect(previewSessionChange(root, SESSION)).rejects.toThrow(`was written by session ${SESSION}`);
  });
});
