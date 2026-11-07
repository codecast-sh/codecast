#!/usr/bin/env bun
// Real end-to-end check of the Claude SDK backend against the real `claude`:
//
//   bun packages/cli/scripts/claude-sdk-e2e.ts [--keep]
//
// Drives ClaudeSdkBackend (the daemon's side) with host processes started
// from this checkout as launchd jobs, as the daemon starts them, through a
// short scripted conversation: project CLAUDE.md and hooks load, a Bash call
// needs permission and is allowed, a mid-turn steer, an interrupt, an
// AskUserQuestion answered with the web's poll payload, an image, a daemon
// that reattaches, a host killed and resumed. Then it reads the transcript
// with the daemon's own parser.
//
// Isolation as in prompt-dry-run.ts: a private CLAUDE_CONFIG_DIR, so the
// transcript lands outside ~/.claude/projects and the running daemon never
// syncs it into an inbox, and the keychain login handed over in the env only.
// It does not touch the running daemon. Everything it made is removed at the
// end unless --keep.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { ClaudeSdkBackend, type ClaudeSdkBackendDeps } from "../src/claudeSdk/backend.js";
import { readHostState } from "../src/claudeSdk/client.js";
import { sdkHostPaths } from "../src/claudeSdk/paths.js";
import type { SdkActivity, SdkPermissionRequest } from "../src/claudeSdk/protocol.js";
import { isolatedEnv, loginToken } from "../src/subscriptionCall.js";
import { resolveClaudeInstall } from "../src/stableClaudeBinary.js";
import { claudeProjectDirName } from "../src/projectPathResolver.js";
import { parseSessionFile, detectCliFlags } from "../src/parser.js";

const keep = process.argv.includes("--keep");
const real = resolveClaudeInstall();
if (!real) throw new Error("claude is not installed");
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-sdk-e2e-")));
const configDir = path.join(scratch, "config");
const hostDir = path.join(scratch, "hosts");
const cwd = path.join(scratch, "project");
for (const d of [configDir, hostDir, cwd, path.join(cwd, ".claude")]) fs.mkdirSync(d, { recursive: true });

// Project instructions and hooks the session must load, as the terminal would.
fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "When asked for the project marker, reply with exactly MARKER-7731 and nothing else.\n");
const hookLog = path.join(scratch, "hooks.log");
const hookCmd = (event: string) => ({ type: "command", command: `printf '%s backend=%s\\n' ${event} "\${CODECAST_CLAUDE_BACKEND:-none}" >> ${JSON.stringify(hookLog)}` });
fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [hookCmd("SessionStart")] }],
    UserPromptSubmit: [{ hooks: [hookCmd("UserPromptSubmit")] }],
  },
}, null, 2));
// A 64x64 solid red PNG.
const pngPath = path.join(scratch, "red.png");
fs.writeFileSync(pngPath, solidPng(64, [220, 20, 20]));

function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from(rgb)))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// The host inherits this process's env, as a launchd job inherits the daemon's.
Object.assign(process.env, isolatedEnv({ configDir, token: loginToken(), stripModelKeys: true }));

const activity: SdkActivity[] = [];
const permissions: SdkPermissionRequest[] = [];
const results: string[] = [];
const log = (line: string) => console.log(`  ${line}`);
const deps: ClaudeSdkBackendDeps = {
  log: (l) => { if (process.env.E2E_VERBOSE) log(l); },
  castArgv: () => [process.execPath, path.join(import.meta.dir, "..", "src", "main.ts")],
  shellPrefix: () => "",
  activity: (_c, _s, a) => activity.push(a),
  permission: async (_c, _s, request, _settled, opened) => {
    permissions.push(request);
    opened(`e2e-card-${permissions.length}`);
    return { behavior: "allow" };
  },
  turnError: (_c, _s, e) => log(`turn error ${e.kind}: ${e.message}`),
  stopped: (_c, _s, why) => log(`host gone: ${why}`),
  tooOld: (_c, _s, v) => log(`too old: ${v}`),
  transcriptHas: () => false,
  sessionChanged: (_c, prev, next) => log(`session moved ${prev.slice(0, 8)} -> ${next.slice(0, 8)}`),
};

const sessionId = crypto.randomUUID();
const conv = "e2e-conversation";
const transcript = path.join(configDir, "projects", claudeProjectDirName(cwd), `${sessionId}.jsonl`);
const turnEnds = () => activity.filter((a) => a.turnCompletedAt).length;
const until = async <T>(what: string, fn: () => T | undefined | null | false, ms = 300_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const lastReply = () => {
  const msgs = fs.existsSync(transcript) ? parseSessionFile(fs.readFileSync(transcript, "utf-8")) : [];
  return msgs.filter((m) => m.role === "assistant" && m.content).at(-1)?.content ?? "";
};
const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = "") => {
  checks.push([name, ok, detail]);
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const turn = async (backend: ClaudeSdkBackend, id: string, text: string) => {
  const before = turnEnds();
  await backend.deliver(conv, id, text);
  await until(`turn ${id}`, () => turnEnds() > before);
  // The transcript line lands just after the result.
  await new Promise((r) => setTimeout(r, 500));
  return lastReply();
};

let backend = new ClaudeSdkBackend(deps, hostDir);
try {
  console.log(`scratch ${scratch}\nclaude ${real}`);
  await backend.start(conv, {
    conversationId: conv, sessionId, resume: false, cwd, executable: real,
    args: ["--model", "haiku", "--permission-mode", "default", "--session-id", sessionId],
    env: { CODECAST_LAUNCH_TOKEN: "e2e" },
  });
  const label = sdkHostPaths(sessionId, hostDir).label;
  const job = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid!()}/${label}`], { encoding: "utf8" });
  check("host runs as its own launchd job, its plist gone from disk", job.status === 0 && /state = running/.test(job.stdout) && !fs.existsSync(sdkHostPaths(sessionId, hostDir).plist) && !!readHostState(sessionId, hostDir)?.pid, label);

  const marker = await turn(backend, "m1", "What is the project marker?");
  check("project CLAUDE.md loads", marker.includes("MARKER-7731"), marker.slice(0, 80));
  const hooks = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, "utf-8") : "";
  check("project hooks run, and see the SDK backend marker", /SessionStart backend=sdk/.test(hooks) && /UserPromptSubmit backend=sdk/.test(hooks), hooks.trim().replace(/\n/g, " | "));
  check("transcript lands where the watcher looks", fs.existsSync(transcript), path.relative(scratch, transcript));

  const permsBefore = permissions.length;
  const done = await turn(backend, "m2", "Use the Bash tool to run exactly: echo e2e-ok > out.txt   Then reply with the single word done.");
  check("a Bash call opens a permission card, allowed", permissions.length > permsBefore && permissions[permsBefore].toolName === "Bash" && fs.existsSync(path.join(cwd, "out.txt")), `${permissions[permsBefore]?.toolName} -> ${done.slice(0, 40)}`);
  check("permission_blocked reported with the dialog flag", activity.some((a) => a.status === "permission_blocked" && a.dialog));

  {
    const before = turnEnds();
    await backend.deliver(conv, "m3", "Use the Bash tool to run exactly: sleep 6; echo slept   Then reply with the command's output.");
    await until("working", () => activity.slice(-3).some((a) => a.status === "working"));
    await backend.deliver(conv, "m4", "Also: end your final reply with the word STEER-OK.");
    await until("steer turn end", () => turnEnds() > before && !backend.isRunning(conv) || (turnEnds() > before && activity.at(-1)?.status === "idle"));
    await new Promise((r) => setTimeout(r, 1500));
    const reply = lastReply();
    check("a mid-turn message steers the running turn", reply.includes("STEER-OK"), reply.slice(-60));
  }

  {
    const before = turnEnds();
    await backend.deliver(conv, "m5", "Use the Bash tool to run exactly: sleep 90; echo late   Then reply with the word finished.");
    await until("working before interrupt", () => activity.at(-1)?.status === "working");
    const t = Date.now();
    const ok = await backend.interrupt(conv);
    check("interrupt returns once the turn drained", ok && turnEnds() > before, `${Date.now() - t}ms`);
    const after = await turn(backend, "m6", "Reply with exactly the word after and nothing else.");
    check("the next message starts a fresh turn", after.trim().toLowerCase().startsWith("after"), after.slice(0, 40));
  }

  {
    const before = turnEnds();
    await backend.deliver(conv, "m7", "Call the AskUserQuestion tool once, with one single-select question \"Which color?\" (header \"Color\") and the options Red and Blue. After I answer, reply with only the color I chose.");
    await until("question", () => activity.at(-1)?.status === "permission_blocked" && activity.at(-1)?.message === "AskUserQuestion");
    await new Promise((r) => setTimeout(r, 1000));
    const pendingInJsonl = fs.readFileSync(transcript, "utf-8").split("\n").some((l) => l.includes('"name":"AskUserQuestion"'));
    check("the pending AskUserQuestion is already in the transcript (the web card renders from it)", pendingInJsonl);
    await backend.deliver(conv, "m8", JSON.stringify({ __cc_poll: true, keys: ["2"], display: "Blue" }));
    await until("answered", () => turnEnds() > before);
    await new Promise((r) => setTimeout(r, 500));
    check("the web's poll payload answers it", /blue/i.test(lastReply()), lastReply().slice(0, 40));
  }

  const color = await turn(backend, "m9", `What color is this image? Reply with one word. [Image ${pngPath}]`);
  check("an attached image reaches the model", /red/i.test(color), color.slice(0, 40));

  {
    const pid = readHostState(sessionId, hostDir)!.pid;
    backend.detachAll();
    backend = new ClaudeSdkBackend(deps, hostDir);
    const attached = await backend.reattachAll();
    const back = await turn(backend, "m10", "Reply with exactly the word back and nothing else.");
    check("a restarted daemon reattaches to the same host", attached.includes(conv) && readHostState(sessionId, hostDir)?.pid === pid && /back/i.test(back), `pid ${pid}`);
  }

  {
    process.kill(readHostState(sessionId, hostDir)!.pid, "SIGKILL");
    await until("host gone", () => !backend.isRunning(conv), 60_000);
    const recall = await turn(backend, "m11", "What was the project marker you gave me at the start? Reply with just it.");
    check("a killed host resumes the saved session on the next message", recall.includes("MARKER-7731") && readHostState(sessionId, hostDir)?.pid !== undefined, recall.slice(0, 40));
  }

  {
    const content = fs.readFileSync(transcript, "utf-8");
    const msgs = parseSessionFile(content);
    const users = msgs.filter((m) => m.role === "user" && m.content && !m.content.startsWith("[Request interrupted")).map((m) => m.content);
    const firstUser = content.split("\n").find((l) => l.includes('"type":"user"'));
    const entry = firstUser ? JSON.parse(firstUser) : {};
    check("the daemon's parser reads every prompt in order", users[0]?.includes("project marker") && users.some((u) => u.includes("STEER-OK")) && users.at(-1)!.includes("project marker you gave"), `${msgs.length} messages, ${users.length} prompts`);
    check("one transcript for the whole conversation (resume kept the session id)", fs.readdirSync(path.dirname(transcript)).filter((f) => f.endsWith(".jsonl")).length === 1);
    check("not flagged as a headless program run", !(detectCliFlags(content) ?? "").includes("--print"), `entrypoint=${entry.entrypoint} flags=${detectCliFlags(content)}`);
  }
} catch (err) {
  check("run", false, (err as Error).stack ?? String(err));
} finally {
  await backend.stop(conv, { forget: true }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1000));
  const left = readHostState(sessionId, hostDir);
  if (left && (() => { try { process.kill(left.pid, 0); return true; } catch { return false; } })()) process.kill(left.pid, "SIGKILL");
  const jobLeft = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid!()}/${sdkHostPaths(sessionId, hostDir).label}`]).status === 0;
  check("no launchd job left behind", !jobLeft);
  if (!keep) fs.rmSync(scratch, { recursive: true, force: true });
  const failed = checks.filter(([, ok]) => !ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
