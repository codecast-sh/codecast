// A session recorded before the daemon marked interactive launches gains the
// mark on sync when its transcript head shows a person runs it, and never
// otherwise (interactiveMark.ts; the server side is convex
// conversations.markInteractive).
import { beforeEach, describe, expect, test } from "bun:test";
import { detectCliFlags } from "./parser.js";
import { codexLaunchFlags } from "./codexSessionMeta.js";
import { healInteractiveMark, resetInteractiveMarks } from "./interactiveMark.js";

const head = (entrypoint?: string) => JSON.stringify({ type: "user", ...(entrypoint ? { entrypoint } : {}), message: { role: "user", content: "fix the page" } });

describe("healInteractiveMark", () => {
  let asked: string[];
  const mark = async (id: string) => { asked.push(id); };
  beforeEach(() => { asked = []; resetInteractiveMarks(); });

  test("an old session whose head is Claude Code's interactive cli is asked to gain the mark, once per daemon life", () => {
    healInteractiveMark(mark, "conv_old", detectCliFlags(head("cli")));
    healInteractiveMark(mark, "conv_old", detectCliFlags(head("cli")));
    expect(asked).toEqual(["conv_old"]);
  });

  test("an Agent SDK head, -p, an unknown entrypoint and a missing or unreadable head never ask", () => {
    for (const flags of [detectCliFlags(head("sdk-ts")), detectCliFlags(head("sdk-py")), detectCliFlags(head("sdk-cli")), detectCliFlags(head("claude-vscode")), detectCliFlags(head()), detectCliFlags(""), detectCliFlags("{not json"), undefined]) {
      healInteractiveMark(mark, "conv_sdk", flags);
    }
    expect(asked).toEqual([]);
  });

  test("a Codex thread from its terminal UI or VS Code extension asks; exec and codecast's app-server do not", () => {
    healInteractiveMark(mark, "conv_tui", codexLaunchFlags({ originator: "codex_cli_rs", source: "cli" }));
    healInteractiveMark(mark, "conv_ide", codexLaunchFlags({ originator: "codex_cli_rs", source: "vscode" }));
    healInteractiveMark(mark, "conv_exec", codexLaunchFlags({ originator: "codex_exec", source: "exec" }));
    healInteractiveMark(mark, "conv_app", codexLaunchFlags({ originator: "codecast", source: "vscode" }));
    expect(asked).toEqual(["conv_tui", "conv_ide"]);
  });

  test("a server without the function stops every ask for the rest of the daemon life, after one", async () => {
    const lines: string[] = [];
    const old = async (id: string) => {
      asked.push(id);
      throw new Error("[Request ID: 1] Server Error\nCould not find public function for 'conversations:markInteractive'. Did you forget to run `npx convex dev` or `npx convex deploy`?");
    };
    healInteractiveMark(old, "conv_a", "--interactive", (l) => lines.push(l));
    await Promise.resolve();
    await Promise.resolve();
    for (const id of ["conv_a", "conv_b", "conv_c"]) healInteractiveMark(old, id, "--interactive", (l) => lines.push(l));
    expect(asked).toEqual(["conv_a"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not asking again until the daemon restarts");
  });

  test("an ask that failed is asked again on a later pass", async () => {
    let fail = true;
    const flaky = async (id: string) => { asked.push(id); if (fail) throw new Error("offline"); };
    healInteractiveMark(flaky, "conv_old", "--interactive");
    await Promise.resolve();
    await Promise.resolve();
    fail = false;
    healInteractiveMark(flaky, "conv_old", "--interactive");
    expect(asked).toEqual(["conv_old", "conv_old"]);
  });
});
