import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { isolateCodecastDir } from "../../test-helpers/codecastDir.js";
import { freePort } from "../instance.js";
import { startBridgeHost, type RunningHost } from "./host.js";
import { hashHostToken, matchHostClient, newHostClient, type HostClients } from "./hostClients.js";
import { lastLinkedLaptop, probeLaptopLink, readLaptopLinkClosed, revokedVerdict, switchNotice, type LaptopLink } from "./laptopLink.js";
import { CLOSE_BAD_TOKEN } from "./protocol.js";
import { dial, FakeExtension, TEST_TOKEN } from "./host.testutil.js";
import { BROWSER_LINK_REMOTE, browserLinkArgs, browserLinkRefusal } from "../../cloud/browserLink.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function bridgeWithHosts(clients: HostClients): Promise<{ port: number; host: RunningHost; lines: string[] }> {
  const home = isolateCodecastDir("cast-hostclients-test-");
  const port = await freePort();
  const lines: string[] = [];
  const host = await startBridgeHost({ port, token: TEST_TOKEN, hostClients: () => clients, onHostClient: (l) => lines.push(l) });
  cleanups.push(() => home.restore(), () => host.close());
  return { port, host, lines };
}

const closeCode = (ws: WebSocket, ms = 5000) =>
  new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("did not close")), ms);
    ws.once("close", (code) => { clearTimeout(t); resolve(code); });
  });

describe("host-scoped bridge tokens", () => {
  test("a host token matches only its own record", () => {
    const a = newHostClient("a");
    const b = newHostClient("b");
    const clients = { "i-a": a.record, "i-b": b.record };
    expect(matchHostClient(clients, a.token)).toBe("i-a");
    expect(matchHostClient(clients, b.token)).toBe("i-b");
    expect(matchHostClient(clients, TEST_TOKEN)).toBeNull();
    expect(a.record.hash).toBe(hashHostToken(a.token));
    expect(JSON.stringify(clients)).not.toContain(a.token);
  });

  test("a host token opens CDP and the client routes, never the machine token's URL or the extension's routes", async () => {
    const minted = newHostClient("i-1");
    const { port, lines } = await bridgeWithHosts({ "i-1": minted.record });
    const ext = await new FakeExtension([{ ...FakeExtension.tab(1, "https://human.example/"), owned: false }, { ...FakeExtension.tab(2), owned: true }]).connect(port);
    cleanups.push(() => ext.ws.close());

    const version = await fetch(`http://127.0.0.1:${port}/json/version?token=${minted.token}`).then((r) => r.json());
    expect(version.webSocketDebuggerUrl).toContain(minted.token);
    expect(version.webSocketDebuggerUrl).not.toContain(TEST_TOKEN);

    const list = await fetch(`http://127.0.0.1:${port}/json/list?token=${minted.token}`).then((r) => r.json());
    expect(list.map((t: any) => t.url)).toEqual(["https://example.com/2"]);

    expect((await fetch(`http://127.0.0.1:${port}/status?token=${minted.token}`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/reload?token=${minted.token}`, { method: "POST" })).status).toBe(403);

    const ws = await dial(port, `/devtools/browser/${minted.token}?session=s1`);
    cleanups.push(() => ws.close());
    const reply = await new Promise<any>((resolve) => {
      ws.once("message", (raw) => resolve(JSON.parse(String(raw))));
      ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    });
    expect(reply.id).toBe(1);
    expect(reply.error).toBeUndefined();
    expect(lines.some((l) => l.includes("cloud host i-1 connected a CDP client for session s1"))).toBe(true);
  });

  test("a host token is not the extension's pairing secret", async () => {
    const minted = newHostClient("i-1");
    const { port } = await bridgeWithHosts({ "i-1": minted.record });
    await expect(new FakeExtension([], minted.token).connect(port)).rejects.toThrow(`closed ${CLOSE_BAD_TOKEN}`);
  });

  test("revoking a host closes its live sockets and refuses the next one", async () => {
    const minted = newHostClient("i-1");
    const clients: HostClients = { "i-1": minted.record };
    const { port } = await bridgeWithHosts(clients);
    const ws = await dial(port, `/devtools/browser/${minted.token}`);
    delete clients["i-1"];
    expect(await closeCode(ws)).toBe(CLOSE_BAD_TOKEN);
    expect(await closeCode(new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/${minted.token}`))).toBe(CLOSE_BAD_TOKEN);
    expect((await fetch(`http://127.0.0.1:${port}/json/list?token=${minted.token}`)).status).toBe(403);
  });
});

describe("the host's view of its link", () => {
  test("laptop when the bridge proves this host's token and the extension is on it; host otherwise", async () => {
    const minted = newHostClient("i-1");
    const clients: HostClients = { "i-1": minted.record };
    const { port } = await bridgeWithHosts(clients);
    const link: LaptopLink = { v: 1, port, token: minted.token, hostId: "i-1", laptop: "mbp", linkedAt: Date.now() };

    expect(await probeLaptopLink(link)).toMatchObject({ mode: "host", reason: expect.stringContaining("extension") });
    const ext = await new FakeExtension([]).connect(port);
    cleanups.push(() => ext.ws.close());
    const v = await probeLaptopLink(link);
    expect(v.mode).toBe("laptop");

    delete clients["i-1"];
    expect(await probeLaptopLink(link)).toMatchObject({ mode: "host", revoked: true, reason: expect.stringContaining("refused this host's key") });
    expect(await probeLaptopLink({ ...link, port: await freePort() }, 500)).toMatchObject({ mode: "host", reason: expect.stringContaining("not reachable") });
  });

  test("one line per switch, silence while the choice holds", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-verdict-")), "v.json");
    const bridge = { port: 1, token: "x", proven: true } as const;
    const laptop = { mode: "laptop", laptop: "mbp", bridge, status: { extensionConnected: true } } as any;
    const host = { mode: "host", laptop: "mbp", reason: "the laptop is not reachable over its link" } as const;
    expect(switchNotice(host, file)).toBeNull();
    expect(switchNotice(laptop, file)).toBe("browser: using mbp's Chrome");
    expect(switchNotice(laptop, file)).toBeNull();
    expect(switchNotice(host, file)).toBe("browser: the laptop is not reachable over its link; using this host's own Chrome");
    expect(switchNotice(host, file)).toBeNull();
    // A revoke after a fallback is news: once.
    expect(switchNotice(revokedVerdict("mbp", "i-1"), file)).toBe("browser: mbp refused this host's key (revoked there); `cast browser extension link --host i-1` on mbp lets this host use its Chrome again; using this host's own Chrome");
    expect(switchNotice(revokedVerdict("mbp", "i-1"), file)).toBeNull();
    expect(lastLinkedLaptop(file)).toBe("mbp");
    expect(lastLinkedLaptop(path.join(path.dirname(file), "none.json"))).toBeNull();
  });
});

describe("the link connection", () => {
  test("its remote side writes the link file 0600 from stdin and removes it when the connection ends", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-link-home-"));
    const child = spawn("bash", ["-c", BROWSER_LINK_REMOTE], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "pipe"] });
    const file = path.join(home, ".codecast/browser/laptop-link.json");
    child.stdin.write('{"v":1}\n');
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(fs.readFileSync(file, "utf-8")).toBe('{"v":1}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const exited = new Promise<number | null>((r) => child.once("exit", r));
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  }, 30_000);

  test("a line after the first is the laptop's closing reason, kept once the link file goes; a new link clears it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-link-home-"));
    const dir = path.join(home, ".codecast/browser");
    const run = () => spawn("bash", ["-c", BROWSER_LINK_REMOTE], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "pipe"] });
    const waitFor = async (f: string) => { const d = Date.now() + 20_000; while (!fs.existsSync(f) && Date.now() < d) await new Promise((r) => setTimeout(r, 20)); };
    const closed = { v: 1, reason: "revoked", laptop: "mbp", hostId: "i-1", at: 1 };
    const a = run();
    a.stdin.write('{"v":1}\n');
    await waitFor(path.join(dir, "laptop-link.json"));
    a.stdin.end(`${JSON.stringify(closed)}\n`);
    expect(await new Promise((r) => a.once("exit", r))).toBe(0);
    expect(fs.existsSync(path.join(dir, "laptop-link.json"))).toBe(false);
    expect(readLaptopLinkClosed(path.join(dir, "laptop-link-closed.json"))).toEqual(closed as any);
    expect(fs.readdirSync(dir).sort()).toEqual(["laptop-link-closed.json"]);

    const b = run();
    b.stdin.write('{"v":1}\n');
    await waitFor(path.join(dir, "laptop-link.json"));
    expect(fs.existsSync(path.join(dir, "laptop-link-closed.json"))).toBe(false);
    b.stdin.end();
    expect(await new Promise((r) => b.once("exit", r))).toBe(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  }, 45_000);

  test("forwards the same port, fails on a taken one, and never links a shared host", () => {
    const args = browserLinkArgs({ address: "h", user: "u", keyPath: "/k", remoteBaseDir: "/w" }, 41729);
    expect(args).toContain("127.0.0.1:41729:127.0.0.1:41729");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args.join(" ")).not.toContain(TEST_TOKEN);
    const bridge = { port: 1, token: "t", extensionSeenAt: 1 };
    const cloud = { id: "i-1", provider: "aws", region: "r", user: "u", keyPath: "/k", watchdogVersion: 4 } as const;
    expect(browserLinkRefusal(cloud, bridge)).toBeNull();
    expect(browserLinkRefusal({ ...cloud, shared: true }, bridge)).toContain("shared");
    expect(browserLinkRefusal({ ...cloud, laptopBrowser: false }, bridge)).toContain("turned off");
    expect(browserLinkRefusal({ ...cloud, watchdogVersion: 3 }, bridge)).toContain("watchdog");
    expect(browserLinkRefusal(cloud, { port: 1, token: "t" })).toContain("never paired");
  });
});
