import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PendingDeliveryHeldError } from "./pendingDeliveryAdmission.js";
import { LaunchPromptCarriedError, launchPromptFragment, launchPromptText, pickLaunchPrompt, promptFileShellWord, transcriptHasUserPrompt } from "./launchPrompt.js";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
// realpath: macOS tmpdir is a symlink, and the shell word must name a path of plain characters.
const tmp = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "launch-prompt-"))); scratch.push(d); return d; };
const row = (over: Record<string, unknown> = {}) => ({ _id: "m1", conversation_id: "conv", content: "Fix the bug.\nReport back.", created_at: 10, ...over });

describe("launchPromptText", () => {
  test("a plain brief rides the launch, newlines kept and the trailing one dropped", () => {
    expect(launchPromptText(row({ content: "Fix the bug.\r\nReport back.\n\n" }))).toBe("Fix the bug.\nReport back.");
  });

  test("a leading dash is a prompt, because the fragment ends the options first", () => {
    expect(launchPromptText(row({ content: "- step one\n- step two" }))).toBe("- step one\n- step two");
  });

  test.each([
    ["an image", { image_storage_ids: ["s1"] }],
    ["a legacy image", { image_storage_id: "s1" }],
    ["a slash command", { content: "/compact" }],
    ["a shell line", { content: "  !ls" }],
    ["a poll answer", { content: JSON.stringify({ __cc_poll: true, keys: ["Enter"] }) }],
    ["nothing", { content: "  \n" }],
    ["a NUL byte", { content: "a\0b" }],
    ["more than one argv entry should hold", { content: "x".repeat(200 * 1024) }],
  ])("%s goes through the composer", (_name, over) => {
    expect(launchPromptText(row(over))).toBeNull();
  });
});

describe("pickLaunchPrompt", () => {
  test("takes the oldest message waiting for the conversation", () => {
    const rows = [row({ _id: "late", created_at: 30 }), row({ _id: "other", conversation_id: "x", created_at: 1 }), row({ _id: "first", created_at: 20, content: "first" })];
    expect(pickLaunchPrompt(rows, "conv")).toMatchObject({ row: { _id: "first" }, text: "first" });
  });

  test("nothing waiting, or a first message the composer must take, launches bare", () => {
    expect(pickLaunchPrompt([row({ conversation_id: "x" })], "conv")).toBeNull();
    // A later plain message must not jump ahead of the one delivery would paste first.
    expect(pickLaunchPrompt([row({ _id: "cmd", content: "/model", created_at: 1 }), row({ created_at: 2 })], "conv")).toBeNull();
  });
});

describe("the launch fragment", () => {
  // The fragment is typed into a live shell, so run it through one: the text
  // must arrive as ONE argument after `--`, whatever it contains.
  const argvThroughShell = (fragment: string): string[] =>
    execFileSync("sh", ["-c", `printf '%s\\0' --flag${fragment}`], { encoding: "utf8" }).split("\0").slice(0, -1);

  test("carries any text as one argument after the options, and the file is gone once read", () => {
    const dir = tmp();
    const text = `- "quoted" $(rm -rf nothing) \`tick\` $HOME 'single'\n\nsecond paragraph; echo hi | cat`;
    const fragment = launchPromptFragment(dir, "jx7conv", text);
    expect(fragment).toBe(` -- "$(cat ${dir}/jx7conv.md; rm -f ${dir}/jx7conv.md)"`);
    expect(fs.statSync(path.join(dir, "jx7conv.md")).mode & 0o777).toBe(0o600);
    expect(argvThroughShell(fragment)).toEqual(["--flag", "--", text]);
    expect(fs.existsSync(path.join(dir, "jx7conv.md"))).toBe(false);
  }, 30_000);

  test("a kept prompt file stays for the next launch", () => {
    const dir = tmp();
    expect(promptFileShellWord(dir, "a b/c", "hi")).toBe(`"$(cat ${dir}/a_b_c.md)"`);
    expect(fs.readFileSync(path.join(dir, "a_b_c.md"), "utf8")).toBe("hi");
  });

  test("refuses a directory the shell would have to parse", () => {
    expect(() => promptFileShellWord(path.join(tmp(), "has space"), "k", "hi")).toThrow("not shell-safe");
  });
});

describe("transcriptHasUserPrompt", () => {
  const line = (o: unknown) => JSON.stringify(o);
  test("a submitted prompt counts, as text or as a text block", () => {
    expect(transcriptHasUserPrompt(line({ type: "user", message: { role: "user", content: "do it" } }))).toBe(true);
    expect(transcriptHasUserPrompt(line({ type: "user", message: { role: "user", content: [{ type: "text", text: "do it" }] } }))).toBe(true);
  });

  test("rows the client writes before the first prompt do not", () => {
    const boot = [
      line({ type: "mode", mode: "normal" }),
      line({ type: "permission-mode", permissionMode: "bypassPermissions" }),
      line({ attachment: { type: "hook_success", hookName: "SessionStart:startup", stdout: 'a "type":"user" lookalike' } }),
      line({ type: "user", isMeta: true, message: { role: "user", content: "caveat" } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } }),
      '{"type":"user", truncated',
    ].join("\n");
    expect(transcriptHasUserPrompt(boot)).toBe(false);
    expect(transcriptHasUserPrompt("")).toBe(false);
  });
});

test("a carried message reads as a held delivery to every injection path", () => {
  expect(new LaunchPromptCarriedError()).toBeInstanceOf(PendingDeliveryHeldError);
});
