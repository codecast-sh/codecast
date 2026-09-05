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
    expect(() => parseAcquireOutput("cloud-3", broken)).toThrow(/cloud-3 on the host is broken/);
  });
  test.each([
    { name: "someone-else" }, { state: "creating" }, { state: "broken" },
    { contract: null }, { contract: { ok: "true", failures: [] } },
    { contract: { ok: true } }, { contract: { ok: true, failures: ["failed"] } },
    { path: "relative/path" }, { path: "/" }, { path: "/p/../escape" }, { path: "/p\n" },
    { branch: "" }, { branch: "bad branch" }, { created: "true" },
    { ports: null }, { ports: [] }, { ports: { web: 0 } }, { ports: { web: 65536 } },
    { ports: { web: 1.5 } }, { ports: { web: "3221" } },
  ])("rejects malformed or unsuccessful acquisition: %j", (bad) => {
    expect(() => parseAcquireOutput("cloud-1", JSON.stringify({ ...JSON.parse(ok), ...bad }))).toThrow();
  });
  test("accepts ready existing workspaces and valid port bounds", () => {
    expect(parseAcquireOutput("cloud-1", JSON.stringify({ ...JSON.parse(ok), created: false, ports: { a: 1, z: 65535 } })).created).toBe(false);
  });
  test("does not expose output contents in JSON errors", () => {
    expect(() => parseAcquireOutput("cloud-1", "SECRET_VALUE")).toThrow("cloud-1 printed no JSON");
    expect(() => parseAcquireOutput("cloud-1", '{"SECRET_VALUE"')).toThrow("cloud-1 printed invalid JSON");
  });
});

describe("launchModelKey — the row's model id back to the launch option key", () => {
  test("claude rows carry claude-<key>; other agents keep the id", () => {
    expect(launchModelKey("claude-opus", "claude_code")).toBe("opus");
    expect(launchModelKey("gpt-5", "codex")).toBe("gpt-5");
    expect(launchModelKey(null, "claude_code")).toBeUndefined();
  });
});
