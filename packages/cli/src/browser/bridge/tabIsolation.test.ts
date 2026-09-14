import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CdpConnection, cdpHttpUrl, listTargets } from "../cdp.js";
import { ensurePinnedTab, readBoundTarget, writeBoundTarget } from "../pinnedTab.js";
import { grantTab, writeBridgeState } from "./host.js";
import { FakeExtension, testBridgeHost } from "./host.testutil.js";
import { targetIdOfTab } from "./protocol.js";

let host: Awaited<ReturnType<typeof testBridgeHost>>;
let extension: FakeExtension;
let dir: string;
let previousSocketDir: string | undefined;
const connections: CdpConnection[] = [];
const humanId = 505538306;
const humanUrl = "https://www.reddit.com/r/parkslope/comments/example/";

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-tab-isolation-"));
  previousSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR;
  process.env.AGENT_BROWSER_SOCKET_DIR = dir;
  host = await testBridgeHost();
  extension = await new FakeExtension([FakeExtension.tab(humanId, humanUrl)]).connect(host.port);
});

afterEach(async () => {
  for (const conn of connections.splice(0)) conn.close();
  extension?.ws.close();
  await host?.close();
  if (previousSocketDir === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
  else process.env.AGENT_BROWSER_SOCKET_DIR = previousSocketDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const endpoint = (session?: string) => ({ port: host.port, token: host.token, ...(session ? { session } : {}) });

async function connect(session: string): Promise<CdpConnection> {
  const conn = await CdpConnection.fromPort(endpoint(session));
  connections.push(conn);
  return conn;
}

test("HTTP discovery carries the session and matches the WebSocket partition", async () => {
  const a = await connect("env-a-real");
  const b = await connect("env-b-real");
  const { targetId } = await a.send("Target.createTarget", { url: "https://a.example/" });
  expect((await listTargets(endpoint("env-a-real"))).map(t => t.targetId)).toEqual([targetId]);
  expect(await listTargets(endpoint("env-b-real"))).toEqual([]);
  expect((await b.send("Target.getTargets")).targetInfos).toEqual([]);
  expect((await listTargets(endpoint())).map(t => t.targetId)).toContain(targetIdOfTab(humanId));
  const version = await fetch(cdpHttpUrl(endpoint("env-a-real"), "/json/version")).then(r => r.json());
  expect(new URL(version.webSocketDebuggerUrl).searchParams.get("session")).toBe("env-a-real");
});

test("a fresh session opens its requested page while human and other agent tabs stay untouched", async () => {
  const other = await connect("env-other-real");
  const { targetId: otherId } = await other.send("Target.createTarget", { url: "https://other.example/" });
  const session = "env-workspace-real";
  const url = "https://admin.google.com/ac/apps/gmail/defaultrouting";
  expect(await ensurePinnedTab(session, url)).toBe(true);
  const targetId = readBoundTarget(session);
  if (!targetId) throw new Error("requested page was not pinned");
  expect(targetId).not.toBe(otherId);
  expect(targetId).not.toBe(targetIdOfTab(humanId));
  expect(await ensurePinnedTab(session)).toBe(false);
  const conn = await connect(session);
  const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
  const result = await conn.send("Runtime.evaluate", { expression: "location.href" }, sessionId);
  expect(targetIdOfTab(result.echo.tabId)).toBe(targetId);
  expect(extension.tabs.map(t => t.url)).toEqual([humanUrl, "https://other.example/", url]);
  expect(extension.seen.filter(m => m.op === "attach")).toMatchObject([{ owned: true }]);
});

test("opening a page allows a slow bridge browser-socket discovery", async () => {
  const proxy = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/json/version") await new Promise(resolve => setTimeout(resolve, 5_200));
      return fetch(`http://127.0.0.1:${host.port}${url.pathname}${url.search}`);
    },
  });
  writeBridgeState({ port: proxy.port!, token: host.token });
  try {
    expect(await ensurePinnedTab("env-slow-discovery-real", "https://requested.example/")).toBe(true);
    expect(extension.tabs.map(t => t.url)).toEqual([humanUrl, "https://requested.example/"]);
  } finally {
    proxy.stop(true);
  }
}, 30_000);

test("the tabs command waits for a slow extension without opening a page", async () => {
  const dispatch = extension.ws.listeners("message")[0];
  extension.ws.removeAllListeners("message");
  extension.ws.on("message", raw => {
    if (JSON.parse(String(raw)).op === "tabs.list") {
      setTimeout(() => {
        if (extension.ws.readyState === 1) dispatch.call(extension.ws, raw);
      }, 5_200);
    } else dispatch.call(extension.ws, raw);
  });
  const runner = path.join(dir, "tabs-cli.ts");
  fs.writeFileSync(runner, `import { Command } from ${JSON.stringify(import.meta.resolve("commander"))};
import { registerEngineCommands } from ${JSON.stringify(path.resolve(import.meta.dir, "../cliEngine.ts"))};
const program = new Command();
registerEngineCommands(program.command("browser"), { detectCurrentSessionId: () => null });
await program.parseAsync(["node", "fixture", "browser", "tabs"]);
`);
  const child = Bun.spawn([process.execPath, runner], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "slow-tab-list" }, stdout: "pipe", stderr: "pipe",
  });
  const [status, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  expect(extension.tabs.map(t => t.url)).toEqual([humanUrl]);
  expect(readBoundTarget("env-slow-tab-list-real")).toBeNull();
}, 30_000);

test("a stale saved tab ID cannot claim a human tab even with a live engine", async () => {
  const session = "env-stale-real";
  writeBoundTarget(session, targetIdOfTab(humanId), dir, "https://mail.google.com/");
  fs.writeFileSync(path.join(dir, `${session}.pid`), String(process.pid));
  await expect(ensurePinnedTab(session, "https://admin.google.com/")).rejects.toThrow("ownership");
  expect(await listTargets(endpoint(session))).toEqual([]);
  expect(extension.seen.filter(m => m.op !== "tabs.list")).toEqual([]);
});

test("a closed owned tab is replaced on open without adopting another tab", async () => {
  const session = "env-reopen-real";
  await ensurePinnedTab(session, "https://before.example/");
  const oldTarget = readBoundTarget(session);
  const conn = await connect(session);
  await conn.send("Target.closeTarget", { targetId: oldTarget });
  fs.writeFileSync(path.join(dir, `${session}.pid`), String(process.pid));
  expect(await ensurePinnedTab(session, "https://after.example/")).toBe(true);
  expect(readBoundTarget(session)).not.toBe(oldTarget);
  expect(extension.tabs.map(t => t.url)).toEqual([humanUrl, "https://after.example/"]);
});

test("scoped target commands require an existing grant; explicit agent sharing still works", async () => {
  const a = await connect("env-owner-real");
  const b = await connect("env-stranger-real");
  const { targetId } = await a.send("Target.createTarget", { url: "https://owned.example/" });
  for (const id of [targetId, targetIdOfTab(humanId)]) {
    for (const method of ["Target.attachToTarget", "Target.getTargetInfo", "Target.activateTarget", "Target.closeTarget"]) {
      await expect(b.send(method, { targetId: id })).rejects.toThrow("not granted");
    }
    await expect(grantTab(endpoint(), "env-stranger-real", id, { own: true })).rejects.toThrow("ownership");
  }
  expect(extension.seen.filter(m => ["attach", "tabs.close", "tabs.activate"].includes(m.op))).toEqual([]);
  await grantTab(endpoint(), "env-stranger-real", targetId);
  expect((await listTargets(endpoint("env-stranger-real"))).map(t => t.targetId)).toEqual([targetId]);
  await expect(b.send("Target.attachToTarget", { targetId })).resolves.toHaveProperty("sessionId");
  expect(extension.tabs.find(t => t.tabId === humanId)?.url).toBe(humanUrl);
});

test("tab switch can explicitly share an agent tab as a session's first command", async () => {
  const owner = await connect("env-share-owner-real");
  const { targetId } = await owner.send("Target.createTarget", { url: "https://shared.example/" });
  const binary = path.join(dir, "engine");
  const data = JSON.stringify({ success: true, data: { tabs: [{ targetId, tabId: "t1", active: true, url: "https://shared.example/" }] } });
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${data}'\n`, { mode: 0o700 });
  const runner = path.join(dir, "cli.ts");
  const module = path.resolve(import.meta.dir, "../cliEngine.ts");
  const commander = import.meta.resolve("commander");
  fs.writeFileSync(runner, `import { Command } from ${JSON.stringify(commander)};
import { registerEngineCommands } from ${JSON.stringify(module)};
const program = new Command();
registerEngineCommands(program.command("browser"), { detectCurrentSessionId: () => null });
const args = process.env.CAST_TEST_SHARE_FLOW === "1"
  ? ["do", "tab switch ${targetId}", "--no-shot", "--no-capture"]
  : ["tab", "switch", ${JSON.stringify(targetId)}, "--no-shot", "--no-capture"];
await program.parseAsync(["node", "fixture", "browser", ...args]);
`);
  for (const flow of [false, true]) {
    const recipient = `share-recipient-${flow}`;
    const child = Bun.spawn([process.execPath, runner], {
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: recipient, CAST_BROWSER_ENGINE: binary, CAST_TEST_SHARE_FLOW: flow ? "1" : "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const [status, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    expect(readBoundTarget(`env-${recipient}-real`)).toBe(targetId);
    expect(extension.tabs).toHaveLength(2);
    expect((await listTargets(endpoint(`env-${recipient}-real`))).map(t => t.targetId)).toEqual([targetId]);
  }
}, 30_000);
