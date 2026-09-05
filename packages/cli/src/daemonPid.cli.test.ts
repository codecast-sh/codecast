import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { version } from "../package.json";

const roots: string[] = [];
const cli = fileURLToPath(new URL("./main.ts", import.meta.url));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const scenarios = ["EPERM", "EACCES"].flatMap(code =>
  ["current", "older", ...(process.platform === "darwin" ? ["launchd"] : [])].map(mode => [code, mode] as const),
);

test.each(scenarios)("CLI dispatches after %s with a %s daemon without replacing it", (code, mode) => {
  const root = mkdtempSync(join(tmpdir(), "codecast-pid-cli-"));
  roots.push(root);
  const configDir = join(root, ".codecast");
  mkdirSync(configDir);
  const pidFile = join(configDir, "daemon.pid");
  const eventsFile = join(root, "events.json");
  const preload = join(root, "sandbox.ts");
  if (mode === "launchd") {
    const agents = join(root, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "sh.codecast.daemon.plist"), "");
  } else {
    writeFileSync(pidFile, "1234\n");
  }
  writeFileSync(join(configDir, "daemon.version"), mode === "older" ? "0.0.0" : version);
  writeFileSync(join(configDir, "daemon.build"), "different-build");
  writeFileSync(join(configDir, "config.json"), JSON.stringify({
    auth_token: "test-only-token",
    convex_url: "https://codecast.invalid",
  }));
  writeFileSync(preload, `
import fs from "node:fs";
import childProcess from "node:child_process";
import { mock } from "bun:test";
const events = [];
process.on("exit", () => fs.writeFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(events)));
process.kill = (pid, signal) => {
  events.push({ kind: "signal", pid, signal });
  if (pid !== 1234 || (signal !== 0 && signal !== "SIGTERM")) throw new Error("Unexpected process signal");
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
const subprocessGuards = {};
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  subprocessGuards[name] = (...args) => {
    if (name === "spawnSync" && args[0] === "which") return { status: 1, stdout: "", stderr: "" };
    if (name === "execFileSync" && ["/usr/sbin/ioreg", "reg"].includes(args[0])) return "";
    if (name === "spawnSync" && args[0] === "launchctl" && args[1]?.[0] === "print") {
      events.push({ kind: "discovery", command: "launchctl" });
      return { status: 0, stdout: "state = running\\npid = 1234\\n", stderr: "" };
    }
    events.push({ kind: "subprocess", name, command: args[0] });
    throw new Error("Unexpected subprocess during CLI command");
  };
}
const subprocesses = { ...childProcess, ...subprocessGuards };
mock.module("node:child_process", () => ({ ...subprocesses, default: subprocesses }));
mock.module("child_process", () => ({ ...subprocesses, default: subprocesses }));
mock.module("node:fs", () => ({ ...fs, default: fs }));
mock.module("fs", () => ({ ...fs, default: fs }));
globalThis.fetch = async (url, init) => {
  const pathname = new URL(String(url)).pathname;
  events.push({ kind: "request", pathname, body: JSON.parse(String(init.body)) });
  return Response.json({ short_id: "jx7test", state: "Sandbox boot verified", status: "done" });
};
process.argv = [process.execPath, ${JSON.stringify(cli)}, "state", "show", "jx7test", "--json"];
await import(${JSON.stringify(cli)});
`);
  const result = spawnSync(process.execPath, [preload], {
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
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  });
  expect(result.status, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}\n${readFileSync(eventsFile, "utf8")}`).toBe(0);
  if (mode === "launchd") expect(existsSync(pidFile)).toBe(false);
  else expect(readFileSync(pidFile, "utf8")).toBe("1234\n");
  const events = JSON.parse(readFileSync(eventsFile, "utf8"));
  expect(events.filter((event: { kind: string }) => event.kind === "signal")).toEqual([
    { kind: "signal", pid: 1234, signal: 0 },
    ...(mode === "older" ? [
      { kind: "signal", pid: 1234, signal: 0 },
      { kind: "signal", pid: 1234, signal: "SIGTERM" },
    ] : []),
  ]);
  expect(events.filter((event: { kind: string }) => event.kind === "discovery")).toEqual(
    mode === "launchd" ? [{ kind: "discovery", command: "launchctl" }] : [],
  );
  expect(events.filter((event: { kind: string }) => event.kind === "unlink" || event.kind === "subprocess")).toEqual([]);
  expect(events.filter((event: { kind: string; pathname: string }) => event.kind === "request" && event.pathname === "/cli/sessions/state/get")).toEqual([
    { kind: "request", pathname: "/cli/sessions/state/get", body: { api_token: "test-only-token", session: "jx7test" } },
  ]);
}, 20_000);

test.skipIf(process.platform === "win32")("release builder stops before compiling when the PID regressions fail", () => {
  const root = mkdtempSync(join(tmpdir(), "codecast-pid-release-"));
  roots.push(root);
  const scripts = join(root, "packages", "cli", "scripts");
  const bin = join(root, "bin");
  const trace = join(root, "commands");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  const builder = join(scripts, "build-binaries.sh");
  writeFileSync(builder, readFileSync(new URL("../scripts/build-binaries.sh", import.meta.url)));
  writeFileSync(join(scripts, "guard-no-src-shadow.sh"), "exit 0\n");
  writeFileSync(join(bin, "bun"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PID_RELEASE_TRACE"\nexit 37\n', { mode: 0o755 });
  const result = spawnSync("bash", [builder], {
    cwd: root,
    env: { PATH: `${bin}${delimiter}${process.env.PATH}`, PID_RELEASE_TRACE: trace, HOME: root },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });
  expect(result.status, `${result.error ?? ""}\n${result.stderr}`).toBe(37);
  expect(readFileSync(trace, "utf8")).toBe("test src/daemonPid.test.ts src/daemonPid.cli.test.ts\n");
});
