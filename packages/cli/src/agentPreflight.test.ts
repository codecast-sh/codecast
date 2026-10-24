import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classifySmoke, parseVersion, preflightAgents, versionAtLeast, type Runner } from "./agentPreflight";

describe("classifySmoke", () => {
  test("an answer of ok is ok", () => {
    expect(classifySmoke({ code: 0, timedOut: false, output: "ok\n" }).status).toBe("ok");
  });
  test("a refused sign-in is auth_failed, whatever the exit code", () => {
    expect(classifySmoke({ code: 1, timedOut: false, output: "Invalid API key · Please run /login" }).status).toBe("auth_failed");
    expect(classifySmoke({ code: 1, timedOut: false, output: "Error: Not logged in. Run codex login" }).status).toBe("auth_failed");
  });
  test("a timeout is timed_out; anything else is smoke_failed with the tail", () => {
    expect(classifySmoke({ code: null, timedOut: true, output: "" }).status).toBe("timed_out");
    expect(classifySmoke({ code: 2, timedOut: false, output: "boom\nsegfault" })).toEqual({ status: "smoke_failed", detail: "boom segfault" });
  });
});

describe("versions", () => {
  test("parses the version out of each agent's --version line", () => {
    expect(parseVersion("2.1.310 (Claude Code)")).toBe("2.1.310");
    expect(parseVersion("codex-cli 0.163.0")).toBe("0.163.0");
  });
  test("compares numerically, not as strings", () => {
    expect(versionAtLeast("0.163.0", "0.50.0")).toBe(true);
    expect(versionAtLeast("0.9.0", "0.50.0")).toBe(false);
    expect(versionAtLeast("2.0.0", "2.0.0")).toBe(true);
  });
});

describe("preflightAgents", () => {
  function fakeBin(dir: string, name: string) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
    return p;
  }

  test("finds each agent on the search PATH and classifies every outcome", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
    const claude = fakeBin(dir, "claude");
    const codex = fakeBin(dir, "codex");
    const run: Runner = async (bin, args) => {
      if (args[0] === "--version") return { code: 0, timedOut: false, output: bin === claude ? "2.1.3 (Claude Code)" : "codex-cli 0.10.0" };
      return { code: 0, timedOut: false, output: "ok" };
    };
    const out = await preflightAgents({ searchPath: dir, run, home: dir, knownFolders: false });
    expect(out.find((r) => r.agent === "claude")).toMatchObject({ status: "ok", path: claude, version: "2.1.3" });
    expect(out.find((r) => r.agent === "codex")).toMatchObject({ status: "too_old", path: codex, version: "0.10.0" });
  });

  test("an agent on no folder is not_found and never runs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
    let ran = 0;
    const out = await preflightAgents({ agents: ["codex"], searchPath: dir, home: dir, knownFolders: false, run: async () => { ran++; return { code: 0, timedOut: false, output: "" }; } });
    expect(out).toEqual([{ agent: "codex", min_version: "0.50.0", status: "not_found" }]);
    expect(ran).toBe(0);
  });
});
