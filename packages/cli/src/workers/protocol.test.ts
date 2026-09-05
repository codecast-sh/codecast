import { expect, test } from "bun:test";
import { FrameDecoder, encodeFrame, validateFrame, type WorkerFrame } from "./protocol.js";
import { validProbePayload, validTmuxRead, probeForExec } from "./operations.js";
import { workerEnv, workerInvocation } from "./invocation.js";
const frame: WorkerFrame = { v: 1, kind: "probe", type: "request", id: "a_1", operation: "read", payload: { operation: "ps", args: ["aux"], options: {} }, deadline: Date.now() + 5000 };
test("fragmented and coalesced UTF8 NDJSON frames decode without losing correlation", () => {
  const bytes = Buffer.from(encodeFrame(frame) + encodeFrame({ v: 1, kind: "probe", type: "result", id: "a_1", operation: "read", result: { status: 0, signal: null, killed: false, stdout: "é雪", stderr: "" } }));
  const decoder = new FrameDecoder();
  const out: WorkerFrame[] = [];
  for (const byte of bytes) out.push(...decoder.push(Buffer.from([byte])));
  expect(out).toHaveLength(2); expect(out[0]).toEqual(frame); expect((out[1].result as any).stdout).toBe("é雪");
  decoder.end();
  expect(new FrameDecoder().push(bytes)).toEqual(out);
});
test("invalid direction shapes, versions, kinds, payloads and results reject", () => {
  for (const change of [{ v: 2 }, { kind: "evil" }, { kind: "scan" }, { id: "bad\n" }, { operation: "exec" }, { deadline: NaN }, { extra: true }, { payload: {} }]) expect(() => validateFrame({ ...frame, ...change })).toThrow();
  expect(() => validateFrame({ v: 1, kind: "probe", type: "result", id: "a", operation: "read", result: { stdout: "success" } })).toThrow();
  const d = new FrameDecoder(64);
  expect(() => d.push(Buffer.alloc(65, 120))).toThrow("too large");
  const partial = new FrameDecoder(); partial.push(Buffer.from('{"v":1')); expect(() => partial.end()).toThrow("truncated");
  expect(() => new FrameDecoder().push(Buffer.from("not-json\n"))).toThrow();
});
test("read grammar refuses chained commands, format execution and extra vectors without running them", () => {
  const rejected = [
    ["list-sessions", ";", "kill-server"], ["list-sessions", "\nkill-server"], ["list-sessions;kill-server"],
    ["list-panes", "-F", "#(touch /tmp/should-never-exist)"], ["list-panes", "-F", "#{E:evil}"],
    ["display-message", "-p", "#{session_name}", "kill-server"], ["display-message", "#(evil)"],
    ["capture-pane", "-p", "-t", "safe;kill-server"], ["capture-pane", "-b", "buffer"],
    ["set-option", "-g", "evil", "1"], ["show-options", "-qv", "@codecast_session_id", ";", "new-session"],
    ["list-panes", "-F", "#{session_name}\\;"], ["-L", "safe\n", "list-sessions"],
  ];
  for (const args of rejected) {
    expect(validTmuxRead(args), JSON.stringify(args)).toBe(false);
    expect(() => encodeFrame({ ...frame, payload: { operation: "tmux", args, options: {} } })).toThrow();
  }
  for (const args of [["list-sessions", "-F", "#{session_name}|#{@codecast_session_id}"], ["-L", "f1-own", "capture-pane", "-pJ", "-t", "%1", "-S", "-100"], ["show-options", "-qv", "-t", "cc-session:0.0", "@codecast_session_id"], ["display-message", "-p", "#{pid}"]]) expect(validTmuxRead(args)).toBe(true);
});
test("fixed program shapes and bounded options forbid arbitrary exec or write capabilities", () => {
  for (const [file,args] of [["sh",["-c","ps"]], ["launchctl",["kickstart","gui/501/app"]], ["security",["delete-generic-password","-s","x"]], ["ps",["-p","1;kill"]]] as [string,string[]][]) expect(probeForExec(file,args,{})).toBeNull();
  expect(validProbePayload({ operation: "ps", args: ["aux"], options: { shell: true } })).toBe(false);
  expect(validProbePayload({ operation: "ps", args: ["aux"], options: { timeout: 0 } })).toBe(false);
  expect(validProbePayload({ operation: "ps", args: ["aux"], options: { timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: { PATH: "/usr/bin" } } })).toBe(true);
});
test("entry invocation supports source, built Node/Bun and compiled binary without runtime TS assumptions", () => {
  expect(workerInvocation("probe", "/bin/bun", "/repo/src/daemon.ts")).toEqual({ command: "/bin/bun", args: ["/repo/src/main.ts", "_worker", "probe"] });
  expect(workerInvocation("scan", "/bin/node", "/repo/dist/main.js")).toEqual({ command: "/bin/node", args: ["/repo/dist/main.js", "_worker", "scan"] });
  expect(workerInvocation("ingest", "/bin/cast", "/$bunfs/root/main.js")).toEqual({ command: "/bin/cast", args: ["_worker", "ingest"] });
});
test("worker environment drops session/update preload markers without altering inherited permissions", () => {
  const env = workerEnv({ CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CODEX_THREAD_ID: "x", XPC_SERVICE_NAME: "x", NODE_OPTIONS: "--import evil", PATH: "/path", CODEX_SANDBOX_NETWORK_DISABLED: "1", HOME: "/home" }, 123);
  expect(env).toEqual({ PATH: "/path", CODEX_SANDBOX_NETWORK_DISABLED: "1", HOME: "/home", CODECAST_WORKER: "1", CODECAST_WORKER_PARENT_PID: "123" });
});

test("invalid UTF8 cannot silently alter a wire identity or result", () => {
  const bytes = Buffer.concat([Buffer.from('{"v":1,"kind":"probe","type":"request","id":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  expect(() => new FrameDecoder().push(bytes)).toThrow();
});

test("worker static import closure excludes daemon, CLI boot, auth clients and Convex", async () => {
  const { scanSpecifiers } = await import("../daemonBuildIdCompute.js");
  const fs = await import("node:fs"); const path = await import("node:path");
  const queue = [path.join(import.meta.dir, "runtime.ts")], seen = new Set<string>();
  while (queue.length) {
    const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
    expect(["daemon.ts", "index.ts", "main.ts", "ccAccounts.ts", "codexAccounts.ts"].includes(path.basename(file))).toBe(false);
    for (const spec of scanSpecifiers(fs.readFileSync(file, "utf8"))) {
      expect(spec.includes("convex")).toBe(false);
      if (spec.startsWith(".")) {
        const resolved = path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts"));
        if (fs.existsSync(resolved)) queue.push(resolved);
      }
    }
  }
  expect(seen.size).toBeGreaterThan(5);
});
