// The Claude SDK host process: `cast _claude-sdk-host <spec.json>`.
//
// One per Claude session, started by the daemon as its own launchd job (or a
// detached child where launchd cannot take it), so the conversation outlives
// the daemon the way a tmux pane does: the daemon restarts on every CLI update
// and reattaches over the socket. The host owns the SDK query and Claude
// Code's process; it exits when Claude exits or when told to stop.
//
// Protocol: protocol.ts. Every connection gets the full state on hello, and
// every change is broadcast to every connection, so a daemon that reconnects
// mid-prompt still sees the prompt and can answer it.

import * as fs from "node:fs";
import * as net from "node:net";
import { spawn } from "node:child_process";
import type { Options, SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSdkSession, MINIMUM_CLAUDE_VERSION, versionAtLeast } from "./session.js";
import { sdkQueryOptions, type SdkLaunchSpec } from "./options.js";
import { sdkHostPaths, writeFileAtomic, type SdkHostPaths } from "./paths.js";
import { encodeFrame, frameReader, type ClientFrame, type HostFrame, type SdkHostState } from "./protocol.js";

export interface RunHostOptions {
  spec: SdkLaunchSpec;
  paths?: SdkHostPaths;
  env?: Record<string, string | undefined>;
  /** The SDK's query(); tests pass the real one too, with a fake claude executable. */
  query?: (params: { prompt: AsyncIterable<any>; options: Options }) => any;
  log?: (line: string) => void;
  /** Called once the host has stopped and cleaned up. Defaults to process.exit. */
  onExit?: (code: number) => void;
}

/** A spawn that runs claude behind an argv prefix (the TCC disclaim wrapper). */
function prefixedSpawn(prefix: string[]): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    const child = spawn(prefix[0], [...prefix.slice(1), options.command, ...options.args], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options.signal,
    });
    return child as unknown as SpawnedProcess;
  };
}

/** Is a live host already answering on this socket? */
function socketAnswers(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.createConnection(socket);
    const done = (ok: boolean) => {
      c.destroy();
      resolve(ok);
    };
    c.once("connect", () => done(true));
    c.once("error", () => done(false));
    setTimeout(() => done(false), 2000);
  });
}

export async function runClaudeSdkHost(opts: RunHostOptions): Promise<{ stop: () => Promise<void>; session: ClaudeSdkSession }> {
  const { spec } = opts;
  const paths = opts.paths ?? sdkHostPaths(spec.sessionId);
  const log = opts.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const exit = opts.onExit ?? ((code: number) => process.exit(code));

  if (fs.existsSync(paths.socket)) {
    if (await socketAnswers(paths.socket)) throw new Error(`a host is already running for ${spec.sessionId}`);
    fs.rmSync(paths.socket, { force: true });
  }

  const queryFn = opts.query ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
  const options = sdkQueryOptions(spec, opts.env ?? process.env);
  if (spec.spawnPrefix?.length) options.spawnClaudeCodeProcess = prefixedSpawn(spec.spawnPrefix);
  options.stderr = (data) => log(`[claude] ${data.trimEnd()}`);
  const session = new ClaudeSdkSession(options, queryFn);
  const startedAt = Date.now();
  const clients = new Set<net.Socket>();
  const handledSends = new Map<string, Promise<string>>();
  let tooOld = false;

  const state = (): SdkHostState => ({
    sessionId: spec.sessionId,
    claudeSessionId: session.claudeSessionId,
    conversationId: spec.conversationId,
    pid: process.pid,
    status: session.status,
    init: session.init,
    pending: session.pending,
    lastError: session.lastError,
    activity: session.activity,
    startedAt,
  });
  const persist = () => {
    try {
      writeFileAtomic(paths.state, JSON.stringify(state()));
    } catch (err) {
      log(`state write failed: ${(err as Error).message}`);
    }
  };
  const broadcast = (frame: HostFrame) => {
    const line = encodeFrame(frame);
    for (const c of clients) if (!c.destroyed) c.write(line);
  };
  const changed = () => {
    persist();
    broadcast({ type: "state", state: state() });
  };

  session.on("status", (s) => {
    log(`status ${s}`);
    changed();
  });
  session.on("activity", (activity) => {
    broadcast({ type: "activity", activity });
    persist();
  });
  session.on("session", (claudeSessionId) => {
    log(`claude moved to session ${claudeSessionId}`);
    broadcast({ type: "session", claudeSessionId });
    changed();
  });
  session.on("permission", (request) => {
    log(`permission ${request.toolName} ${request.requestId}`);
    broadcast({ type: "permission", request });
    persist();
  });
  session.on("permission_settled", (requestId, by) => {
    broadcast({ type: "permission_settled", requestId, by });
    persist();
  });
  session.on("result", (r) => {
    log(`result ${r.subtype}${r.isError ? ` error=${r.error?.kind}` : ""}`);
    broadcast({ type: "result", ...r });
    persist();
  });
  session.on("init", (info) => {
    changed();
    if (!tooOld && info.version && !versionAtLeast(info.version, MINIMUM_CLAUDE_VERSION)) {
      tooOld = true;
      log(`Claude Code ${info.version} is older than ${MINIMUM_CLAUDE_VERSION}; stopping`);
      broadcast({ type: "too_old", version: info.version, minimum: MINIMUM_CLAUDE_VERSION });
      void stop();
    }
  });

  const handle = async (socket: net.Socket, frame: ClientFrame) => {
    const reply = (id: string | undefined, ok: boolean, extra: { error?: string; data?: unknown } = {}) => {
      if (id && !socket.destroyed) socket.write(encodeFrame({ type: "reply", id, ok, ...extra }));
    };
    try {
      switch (frame.op) {
        case "hello":
          socket.write(encodeFrame({ type: "state", state: state() }));
          reply(frame.id, true);
          return;
        case "send": {
          // The daemon retries a send it never saw acknowledged; the same id is the same message.
          // Recorded before the wait for startup, so a retry that lands while Claude boots is the same send.
          const seen = handledSends.get(frame.id);
          if (seen) return reply(frame.id, true, { data: { uuid: await seen, duplicate: true } });
          if (tooOld) return reply(frame.id, false, { error: "claude too old" });
          const sent = session.ready.then(() => session.send(frame.text, frame.images, frame.uuid));
          handledSends.set(frame.id, sent);
          sent.catch(() => handledSends.delete(frame.id));
          if (handledSends.size > 500) handledSends.delete(handledSends.keys().next().value!);
          return reply(frame.id, true, { data: { uuid: await sent } });
        }
        case "interrupt":
          await session.interrupt();
          return reply(frame.id, true);
        case "answer":
          if (session.answer(frame.requestId, frame.answer)) return reply(frame.id, true);
          return reply(frame.id, false, { error: "not pending" });
        case "annotate":
          if (session.annotate(frame.requestId, frame.cardId)) persist();
          return reply(frame.id, true);
        case "set_model":
          await session.setModel(frame.model);
          return reply(frame.id, true);
        case "set_permission_mode":
          await session.setPermissionMode(frame.mode);
          return reply(frame.id, true);
        case "stop":
          reply(frame.id, true);
          await stop();
          return;
      }
    } catch (err) {
      reply((frame as { id?: string }).id, false, { error: (err as Error).message || String(err) });
    }
  };

  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on("data", frameReader<ClientFrame>((frame) => void handle(socket, frame), (line) => log(`bad frame: ${line.slice(0, 200)}`)));
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    fs.chmodSync(paths.socket, 0o600);
  } catch {}
  persist();
  log(`host ${process.pid} up for ${spec.sessionId} (${spec.resume ? "resume" : "new"}) cwd=${spec.cwd}`);

  let stopping: Promise<void> | null = null;
  async function stop(): Promise<void> {
    if (!stopping) stopping = (async () => {
      await session.stop().catch(() => {});
    })();
    return stopping;
  }

  let exited = false;
  session.on("exit", (reason) => {
    if (exited) return;
    exited = true;
    log(`claude exited: ${reason}`);
    persist();
    broadcast({ type: "exit", reason: tooOld ? "too_old" : reason });
    // Let the exit frame reach every client before the sockets close.
    setTimeout(() => {
      for (const c of clients) c.end();
      server.close();
      fs.rmSync(paths.socket, { force: true });
      fs.rmSync(paths.spec, { force: true });
      fs.rmSync(paths.plist, { force: true });
      // A stopped host has no state; the daemon resumes the session from its own binding.
      fs.rmSync(paths.state, { force: true });
      exit(0);
    }, 200);
  });
  session.ready.catch((err) => log(`claude did not start: ${(err as Error).message}`));

  return { stop, session };
}

/** The `cast _claude-sdk-host <spec>` entry. */
export async function claudeSdkHostMain(argv: string[]): Promise<void> {
  const specPath = argv[0];
  if (!specPath) {
    console.error("usage: cast _claude-sdk-host <spec.json>");
    process.exit(2);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, "utf-8")) as SdkLaunchSpec;
  const { unloadOwnLaunchdJob } = await import("../launchdJob.js");
  const { stop } = await runClaudeSdkHost({
    spec,
    onExit: (code) => {
      unloadOwnLaunchdJob();
      process.exit(code);
    },
  });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void stop());
}
