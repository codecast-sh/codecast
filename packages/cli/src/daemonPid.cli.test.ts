import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../package.json";

const roots: string[] = [];
const cli = fileURLToPath(new URL("./main.ts", import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each(["EPERM", "EACCES"])("CLI commands survive a %s daemon probe without touching the daemon", code => {
  const root = mkdtempSync(join(tmpdir(), "codecast-pid-cli-"));
  roots.push(root);
  const configDir = join(root, ".codecast");
  mkdirSync(configDir);
  const pidFile = join(configDir, "daemon.pid");
  const eventsFile = join(root, "events.json");
  const preload = join(root, "sandbox.ts");
  writeFileSync(pidFile, "1234\n");
  writeFileSync(join(configDir, "daemon.version"), version);
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    auth_token: "test-only-token",
    convex_url: "https://codecast.invalid",
  }));
  writeFileSync(preload, `
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const events = [];
process.on("exit", () => fs.writeFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(events)));
process.kill = (pid, signal) => {
  events.push({ kind: "signal", pid, signal });
  if (pid !== 1234 || signal !== 0) throw new Error("Unexpected process signal");
  throw Object.assign(new Error("Probe denied"), { code: ${JSON.stringify(code)} });
};
const unlink = fs.unlinkSync;
fs.unlinkSync = file => {
  if (String(file) === ${JSON.stringify(pidFile)}) {
    events.push({ kind: "unlink" });
    throw Object.assign(new Error("PID file is read-only"), { code: "EPERM" });
  }
  return unlink(file);
};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = (...args) => {
    events.push({ kind: "subprocess", name, command: args[0] });
    throw new Error("Unexpected subprocess during CLI command");
  };
}
syncBuiltinESMExports();
globalThis.fetch = async (url, init) => {
  const pathname = new URL(String(url)).pathname;
  events.push({ kind: "request", pathname, body: JSON.parse(String(init.body)) });
  return Response.json({ short_id: "jx7test", state: "Sandbox boot verified", status: "done" });
};
`);
  const result = spawnSync(process.execPath, ["--preload", preload, cli, "state", "show", "jx7test", "--json"], {
    cwd: root,
    env: {
      HOME: root,
      USERPROFILE: root,
      PATH: process.env.PATH,
      TMPDIR: root,
      CODECAST_NO_AUTO_UPDATE: "1",
      NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(result.status, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`).toBe(0);
  expect(result.stdout, `${result.stderr}\n${readFileSync(eventsFile, "utf8")}`).not.toBe("");
  expect(JSON.parse(result.stdout).state).toBe("Sandbox boot verified");
  expect(readFileSync(pidFile, "utf8")).toBe("1234\n");
  const events = JSON.parse(readFileSync(eventsFile, "utf8"));
  expect(events.filter((event: { kind: string }) => event.kind === "signal")).toEqual([
    { kind: "signal", pid: 1234, signal: 0 },
  ]);
  expect(events.filter((event: { kind: string }) => event.kind === "unlink" || event.kind === "subprocess")).toEqual([]);
  expect(events.filter((event: { kind: string; pathname: string }) => event.kind === "request" && event.pathname === "/cli/sessions/state/get")).toEqual([
    { kind: "request", pathname: "/cli/sessions/state/get", body: { api_token: "test-only-token", session: "jx7test" } },
  ]);
}, 20_000);
