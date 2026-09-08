/**
 * A stand-in for the Swift helper (ct-49519), speaking the same socket
 * protocol, so the client's lifetime and failure machinery is testable on any
 * machine and without a TCC grant.
 *
 * Everything it does differently is chosen by env vars, so one script covers
 * every case the client has to survive: a helper that never answers, one from
 * another release, one on another protocol, one that dies on launch.
 *
 *   FAKE_LAUNCH_LOG          append one line per launch (counts relaunches)
 *   FAKE_VERSION_SEQUENCE    comma list; the Nth launch reports the Nth value
 *   FAKE_PROTOCOL_VERSION    protocol to report in the handshake (default 1)
 *   FAKE_HANG_METHODS        comma list of methods that never answer
 *   FAKE_ERROR_METHODS       JSON: {"method": {"code": …, "message": …}}
 *   FAKE_EXIT_BEFORE_BIND    exit with this code instead of binding
 *   FAKE_DELAY_BIND_MS       wait this long before binding the socket
 *   FAKE_REQUIRE_HANDSHAKE   refuse every request until a handshake arrives,
 *                            the way the real helper refuses a peer it was
 *                            never told about (SocketHandshake.swift)
 */

import * as fs from "node:fs";
import * as net from "node:net";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const statusFile = flag("--permission-status-file");
if (statusFile) {
  fs.writeFileSync(statusFile, JSON.stringify({ accessibility: "granted", screenshots: "not-granted" }));
  process.exit(0);
}

const socketPath = flag("--agent");
const tokenFile = flag("--token-file");
if (!socketPath || !tokenFile) {
  console.error("fake helper needs --agent and --token-file");
  process.exit(2);
}

const launchLog = process.env.FAKE_LAUNCH_LOG;
let launchIndex = 0;
if (launchLog) {
  try {
    launchIndex = fs.readFileSync(launchLog, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    launchIndex = 0;
  }
  fs.appendFileSync(launchLog, `${process.pid}\n`);
}

const exitBeforeBind = process.env.FAKE_EXIT_BEFORE_BIND;
if (exitBeforeBind) process.exit(Number(exitBeforeBind));

const token = fs.readFileSync(tokenFile, "utf-8").trim();
if (!token) process.exit(2);

const versions = (process.env.FAKE_VERSION_SEQUENCE ?? "1.0.0").split(",");
const providerVersion = versions[Math.min(launchIndex, versions.length - 1)];
const protocolVersion = Number(process.env.FAKE_PROTOCOL_VERSION ?? "1");
const hang = new Set((process.env.FAKE_HANG_METHODS ?? "").split(",").filter(Boolean));
const errors = JSON.parse(process.env.FAKE_ERROR_METHODS ?? "{}") as Record<string, { code: string; message: string }>;

const capabilities = {
  platform: "darwin",
  provider: "codecast-computer-macos-fake",
  providerVersion,
  protocolVersion,
  supports: {
    apps: { list: true, bundleIds: true, pids: true },
    windows: { list: true, targetById: true, targetByIndex: true, focus: false, moveResize: false },
    observation: { screenshot: true, annotatedScreenshot: false, elementFrames: true, ocr: false },
    actions: { click: true, typeText: true, pressKey: true, hotkey: true, pasteText: true, scroll: true, drag: false, setValue: true, performAction: true },
    surfaces: { menus: false, dialogs: false, dock: false, menubar: false },
  },
};

const server = net.createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) handle(socket, line);
    }
  });
});

/**
 * The real helper learns which binary may drive it from the `castBinary` the
 * handshake carries, and remembers it for the life of the PROCESS. A helper
 * that never saw a handshake authorizes nobody, so it answers every request
 * with `permission_denied`. That is what a client reconnecting to a fresh
 * helper without re-handshaking actually meets.
 */
const requireHandshake = process.env.FAKE_REQUIRE_HANDSHAKE === "1";
let handshaken = false;

function reply(socket: net.Socket, payload: unknown): void {
  socket.write(`${JSON.stringify(payload)}\n`);
}

function handle(socket: net.Socket, line: string): void {
  let request: { id: number; method: string; params?: unknown; token?: string };
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.token !== token) {
    reply(socket, { id: request.id, ok: false, error: { code: "permission_denied", message: "invalid computer agent token" } });
    return;
  }
  if (requireHandshake && !handshaken && request.method !== "handshake") {
    reply(socket, {
      id: request.id,
      ok: false,
      error: { code: "permission_denied", message: "computer agent peer is not authorized" },
    });
    return;
  }
  if (hang.has(request.method)) return;
  const failure = errors[request.method];
  if (failure) {
    reply(socket, { id: request.id, ok: false, error: failure });
    return;
  }
  if (request.method === "handshake") {
    handshaken = true;
    reply(socket, { id: request.id, ok: true, result: capabilities });
    return;
  }
  if (request.method === "terminate") {
    reply(socket, { id: request.id, ok: true, result: {} });
    socket.end();
    setTimeout(() => process.exit(0), 10);
    return;
  }
  reply(socket, { id: request.id, ok: true, result: { method: request.method, params: request.params ?? null, helperPid: process.pid } });
}

const bind = () => {
  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      /* best effort */
    }
  });
};
const delay = Number(process.env.FAKE_DELAY_BIND_MS ?? "0");
if (delay > 0) setTimeout(bind, delay);
else bind();
