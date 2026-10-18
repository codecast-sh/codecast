import { expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { functionBlock } from "./test-helpers/sourceRegion";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
function lookup(query: (args: string[]) => Promise<{ stdout: string }>) {
  const code = ["normalizeTty", "findTmuxPaneForTty"].map(name => functionBlock(source, name).text).join("\n");
  return new Function("hasTmux", "tmuxExec", new Bun.Transpiler({ loader: "ts" }).transformSync(code) + "\nreturn findTmuxPaneForTty;")(() => true, query);
}

test("known terminal routes without a fleet scan", async () => {
  const calls: string[][] = [];
  const find = lookup(async args => {
    calls.push(args);
    if (args.includes("-a")) throw new Error("fleet unavailable");
    return { stdout: "/dev/ttys071 cc-resume-known:0.0\n" };
  });
  expect(await find("s071", ["cc-resume-known"])).toBe("cc-resume-known:0.0");
  expect(calls).toHaveLength(1);
});

test("a stale candidate cannot take another terminal's message", async () => {
  const calls: string[][] = [];
  const find = lookup(async args => {
    calls.push(args);
    return { stdout: args.includes("-a") ? "/dev/ttys071 correct:0.0" : "/dev/ttys072 wrong:0.0" };
  });
  expect(await find("ttys071", ["stale", "stale"])).toBe("correct:0.0");
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain("-a");
});

test("failed targeted lookup retains fleet fallback", async () => {
  const find = lookup(async args => {
    if (args.includes("-t")) throw new Error("no such session");
    return { stdout: "/dev/ttys071 recovered:0.0" };
  });
  expect(await find("/dev/ttys071", ["gone"])).toBe("recovered:0.0");
});

test("real tmux resolves the known pane without enumerating other servers", async () => {
  const root = mkdtempSync(join(tmpdir(), "cast-tty-route-"));
  const run = promisify(execFile);
  const query = (args: string[]) => run("tmux", ["-S", join(root, "socket"), ...args], { timeout: 5000 });
  try {
    await query(["-f", "/dev/null", "new-session", "-d", "-s", "known", "sleep 120"]);
    const { stdout: tty } = await query(["display-message", "-p", "-t", "known", "#{pane_tty}"]);
    const find = lookup(async args => {
      expect(args).not.toContain("-a");
      return query(args);
    });
    expect(await find(tty.trim(), ["known"])).toBe("known:0.0");
  } finally {
    await query(["kill-server"]);
    rmSync(root, { recursive: true, force: true });
  }
});
