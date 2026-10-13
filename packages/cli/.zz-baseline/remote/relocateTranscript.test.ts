import { expect, test } from "bun:test";
import { relocateTranscript } from "./session-move";
import { claudeProjectDirName } from "../projectPathResolver";

test("a moved transcript names the host's checkout, home and project memory, and comes back naming the laptop's", () => {
  const laptop = { home: "/Users/ashot", cwd: "/Users/ashot/src/codecast" };
  const host = { home: "/home/ubuntu", cwd: "/home/ubuntu/work/codecast" };
  const lines = [
    { cwd: laptop.cwd, message: { content: `Read ${laptop.cwd}/packages/cli/src/a.ts\nthen ${laptop.home}/.claude/projects/${claudeProjectDirName(laptop.cwd)}/memory/MEMORY.md` } },
    { toolUseResult: { stdout: `${laptop.cwd}\n${laptop.home}/.aws/config\n/Users/ashot2/other\n${laptop.cwd}-fork/x` } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const moved = relocateTranscript(lines, laptop, host);
  const [a, b] = moved.split("\n").map((l) => JSON.parse(l));
  expect(a.cwd).toBe(host.cwd);
  expect(a.message.content).toBe(`Read ${host.cwd}/packages/cli/src/a.ts\nthen ${host.home}/.claude/projects/${claudeProjectDirName(host.cwd)}/memory/MEMORY.md`);
  expect(b.toolUseResult.stdout).toBe(`${host.cwd}\n${host.home}/.aws/config\n/Users/ashot2/other\n${host.home}/src/codecast-fork/x`);
  expect(relocateTranscript(moved, host, laptop)).toBe(lines.replace(`${laptop.cwd}-fork/x`, `${laptop.home}/src/codecast-fork/x`));
});
