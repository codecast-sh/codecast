import { describe, expect, test } from "bun:test";
import { freshWorktreeName, parseAcquireOutput, remoteRepoPath } from "./prepare";
import { launchModelKey } from "./cli";

const host = { address: "1.2.3.4", user: "ubuntu", keyPath: "/k", remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };

describe("remoteRepoPath", () => {
  test("the repo lands under the host's work dir with the local basename", () => {
    expect(remoteRepoPath(host, "/Users/a/src/codecast")).toBe("/home/ubuntu/work/codecast");
  });
});

describe("freshWorktreeName", () => {
  test("cloud-<6 hex>, distinct per call", () => {
    const a = freshWorktreeName();
    expect(a).toMatch(/^cloud-[0-9a-f]{6}$/);
    expect(freshWorktreeName()).not.toBe(a);
  });
});

describe("parseAcquireOutput — the host's `cast ws acquire --json`", () => {
  const ok = JSON.stringify({ name: "cloud-1", path: "/home/ubuntu/work/r/.codecast/worktrees/cloud-1", branch: "codecast/cloud-1", state: "ready", ports: { web: 3221 }, created: true, contract: { ok: true, failures: [] } });
  test("takes the last JSON line after install noise", () => {
    const ws = parseAcquireOutput("cloud-1", `bun install v1.3\n+ 400 packages installed\n${ok}\n`);
    expect(ws).toEqual({ name: "cloud-1", path: "/home/ubuntu/work/r/.codecast/worktrees/cloud-1", branch: "codecast/cloud-1", ports: { web: 3221 }, created: true });
  });
  test("no JSON, or a broken contract, is an error that names the worktree", () => {
    expect(() => parseAcquireOutput("cloud-2", "acquire failed: boom")).toThrow(/cloud-2 printed no JSON/);
    const broken = JSON.stringify({ name: "cloud-3", path: "/p", branch: "b", state: "broken", ports: {}, created: true, contract: { ok: false, failures: [{ name: "deps-installed" }] } });
    expect(() => parseAcquireOutput("cloud-3", broken)).toThrow(/cloud-3 on the host is broken.*deps-installed/);
  });
});

describe("launchModelKey — the row's model id back to the launch option key", () => {
  test("claude rows carry claude-<key>; other agents keep the id", () => {
    expect(launchModelKey("claude-opus", "claude_code")).toBe("opus");
    expect(launchModelKey("gpt-5", "codex")).toBe("gpt-5");
    expect(launchModelKey(null, "claude_code")).toBeUndefined();
  });
});
