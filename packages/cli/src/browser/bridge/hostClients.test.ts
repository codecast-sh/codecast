import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { isolateCodecastDir } from "../../test-helpers/codecastDir.js";
import { freePort } from "../instance.js";
import { mintHostClientToken, readBridgeState, revokeHostClient, startBridgeHost, type RunningHost } from "./host.js";
import { hashHostToken, matchHostClient, newHostClient, scopedSession, visibleSessions, type HostClients } from "./hostClients.js";
import { LINK_HOST_PORT_BASE, LINK_HOST_PORT_SPAN, lastLinkedLaptop, linkHostPort, pickLaptopLink, probeLaptopLink, readLaptopLink, readLaptopLinkClosed, readLaptopLinks, revokedVerdict, switchNotice, type LaptopLink } from "./laptopLink.js";
import { CLOSE_BAD_TOKEN, targetIdOfTab } from "./protocol.js";
import { dial, FakeExtension, TEST_TOKEN } from "./host.testutil.js";
import { browserLinkArgs, browserLinkRefusal, browserLinkRemote } from "../../cloud/browserLink.js";

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

    // No session named, nothing shown; a session sees only what was granted to it.
    expect(await fetch(`http://127.0.0.1:${port}/json/list?token=${minted.token}`).then((r) => r.json())).toEqual([]);
    expect(await fetch(`http://127.0.0.1:${port}/json/list?token=${minted.token}&session=s1`).then((r) => r.json())).toEqual([]);

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

  test("a host's sessions are its own: no human tab, no laptop session, no /grant of another's tab", async () => {
    const minted = newHostClient("i-1");
    const { port } = await bridgeWithHosts({ "i-1": minted.record });
    const ext = await new FakeExtension([{ ...FakeExtension.tab(1, "https://bank.example/"), owned: false }, { ...FakeExtension.tab(2), owned: true }]).connect(port);
    cleanups.push(() => ext.ws.close());
    // A laptop session holds agent tab 2.
    const granted = await fetch(`http://127.0.0.1:${port}/grant?token=${TEST_TOKEN}&session=laptop-s&target=${targetIdOfTab(2)}`, { method: "POST" });
    expect(granted.status).toBe(200);

    const caller = (ws: WebSocket) => {
      let id = 0;
      return (method: string, params: object) => new Promise<any>((resolve) => {
        const want = ++id;
        const on = (raw: unknown) => { const m = JSON.parse(String(raw)); if (m.id === want) { ws.off("message", on); resolve(m); } };
        ws.on("message", on);
        ws.send(JSON.stringify({ id: want, method, params }));
      });
    };
    const ws = await dial(port, `/devtools/browser/${minted.token}?session=laptop-s`);
    const bare = await dial(port, `/devtools/browser/${minted.token}`);
    cleanups.push(() => ws.close(), () => bare.close());
    const call = caller(ws);
    // Guessed ids: the human's tab and the laptop session's tab, from a socket
    // that names that session's key and from one that names none.
    for (const c of [call, caller(bare)]) {
      for (const tab of [1, 2]) {
        const r = await c("Target.attachToTarget", { targetId: targetIdOfTab(tab), flatten: true });
        expect(r.error?.message).toContain("not granted");
      }
      expect((await c("Target.getTargets", {})).result.targetInfos).toEqual([]);
    }
    // A session-less host socket cannot make a tab nobody it can see would own.
    expect((await caller(bare)("Target.createTarget", { url: "about:blank" })).error?.message).toContain("only for a session");
    expect(ext.attached.size).toBe(0);
    const list = await fetch(`http://127.0.0.1:${port}/json/list?token=${minted.token}&session=laptop-s`).then((r) => r.json());
    expect(list).toEqual([]);
    const grab = await fetch(`http://127.0.0.1:${port}/grant?token=${minted.token}&session=laptop-s&target=${targetIdOfTab(2)}`, { method: "POST" });
    expect(grab.status).toBe(403);
    const human = await fetch(`http://127.0.0.1:${port}/grant?token=${minted.token}&session=s1&target=${targetIdOfTab(1)}`, { method: "POST" });
    expect(human.status).toBe(403);
    // Its own tabs, listed with or without naming the session.
    const made = await call("Target.createTarget", { url: "about:blank" });
    for (const q of ["", "&session=laptop-s"]) {
      const own = await fetch(`http://127.0.0.1:${port}/json/list?token=${minted.token}${q}`).then((r) => r.json());
      expect(own.map((t: any) => [t.id, t.sessions])).toEqual([[made.result.targetId, ["laptop-s"]]]);
    }
    const status = await fetch(`http://127.0.0.1:${port}/status?token=${minted.token}`).then((r) => r.json());
    expect(status.memory).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain("laptop-s");
    // The laptop still sees its own session on the tab, and nothing of the host's grab.
    const mine = await fetch(`http://127.0.0.1:${port}/json/list?token=${TEST_TOKEN}`).then((r) => r.json());
    expect(mine.find((t: any) => t.id === targetIdOfTab(2)).sessions).toEqual(["laptop-s"]);
    expect(mine.find((t: any) => t.id === made.result.targetId).sessions).toEqual(["host:i-1:laptop-s"]);
  });

  test("session namespacing: a host's sessions carry its id, and it is shown only its own", () => {
    expect(scopedSession({ host: null }, "s")).toBe("s");
    expect(scopedSession({ host: "i-1" }, "s")).toBe("host:i-1:s");
    expect(scopedSession({ host: "i-1" }, "")).toBeNull();
    expect(visibleSessions({ host: "i-1" }, ["s", "host:i-1:a", "host:i-2:b"])).toEqual(["a"]);
    expect(visibleSessions({ host: null }, ["s", "host:i-1:a"])).toEqual(["s", "host:i-1:a"]);
  });

  test("one link per host: a second live holder is refused and the first's token survives", () => {
    const home = isolateCodecastDir("cast-hostclients-holder-");
    cleanups.push(() => home.restore());
    const first = mintHostClientToken("i-1", "i-1", process.ppid);
    expect("token" in first).toBe(true);
    const hash = readBridgeState()!.hostClients!["i-1"]!.hash;
    expect(mintHostClientToken("i-1", "i-1", process.pid)).toEqual({ heldBy: process.ppid });
    expect(readBridgeState()!.hostClients!["i-1"]!.hash).toBe(hash);
    // The holder itself re-mints (its link died and reopens), and a dead holder's record is free.
    expect("token" in mintHostClientToken("i-1", "i-1", process.ppid)).toBe(true);
    const dead = 2 ** 22 + 7;
    revokeHostClient("i-1");
    expect("token" in mintHostClientToken("i-1", "i-1", dead)).toBe(true);
    expect("token" in mintHostClientToken("i-1", "i-1", process.pid)).toBe(true);
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
    const ws = await dial(port, `/devtools/browser/${minted.token}?session=s1`);
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
    expect(switchNotice(revokedVerdict("mbp", "i-1"), file)).toBe("browser: mbp refused this host's key (revoked there). To let this host use that Chrome again, ask your person with a Yes card: cast decide 'Let this cloud host use the Chrome on your laptop again?' --run 'cast browser extension link --host i-1' --on laptop; using this host's own Chrome");
    expect(switchNotice(revokedVerdict("mbp", "i-1"), file)).toBeNull();
    expect(lastLinkedLaptop(file)).toBe("mbp");
    expect(lastLinkedLaptop(path.join(path.dirname(file), "none.json"))).toBeNull();
  });
});

describe("two laptops on one host", () => {
  const link = (laptop: string, device: string | undefined, linkedAt: number, owner = "u1"): LaptopLink =>
    ({ v: 1, port: device ? linkHostPort(device) : 41729, token: `tok-${laptop}`, hostId: "i-1", laptop, linkedAt, ...(device ? { device } : {}), owner });

  test("each laptop forwards to its own host port, so the second link no longer fails on the first one's", () => {
    const a = "3d5c7f9b6bd74d35", b = "8a1f02c4be9d7713";
    expect(linkHostPort(a)).not.toBe(linkHostPort(b));
    for (const d of [a, b]) {
      const p = linkHostPort(d);
      expect(p).toBeGreaterThanOrEqual(LINK_HOST_PORT_BASE);
      expect(p).toBeLessThan(LINK_HOST_PORT_BASE + LINK_HOST_PORT_SPAN);
      expect(linkHostPort(d)).toBe(p);
    }
  });

  test("both links stay readable while both are held, and one closing leaves the other's file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-link-two-"));
    const browser = path.join(home, ".codecast/browser");
    const run = (device: string) => spawn("bash", ["-c", browserLinkRemote(device)], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "pipe"] });
    const waitFor = async (f: string) => { const d = Date.now() + 20_000; while (!fs.existsSync(f) && Date.now() < d) await new Promise((r) => setTimeout(r, 20)); };
    const la = link("mbp-2", "deva", 1), lb = link("mbp-182", "devb", 2);
    const a = run("deva");
    a.stdin.write(`${JSON.stringify(la)}\n`);
    await waitFor(path.join(browser, "laptop-links/deva.json"));
    const b = run("devb");
    b.stdin.write(`${JSON.stringify(lb)}\n`);
    await waitFor(path.join(browser, "laptop-links/devb.json"));
    expect(readLaptopLinks(browser).map((l) => l.laptop)).toEqual(["mbp-182", "mbp-2"]);
    a.stdin.end();
    expect(await new Promise<number | null>((r) => a.once("exit", r))).toBe(0);
    expect(readLaptopLinks(browser).map((l) => l.laptop)).toEqual(["mbp-182"]);
    expect(readLaptopLink(browser, "u1")?.laptop).toBe("mbp-182");
    b.stdin.end();
    expect(await new Promise<number | null>((r) => b.once("exit", r))).toBe(0);
    expect(readLaptopLinks(browser)).toEqual([]);
  }, 45_000);

  test("--on laptop is the one linked laptop; with two it names them, and a name or device prefix picks one", () => {
    const one = [link("mbp-2", "3d5c7f9b6bd74d35", 1)];
    expect("link" in pickLaptopLink(one, "laptop")).toBe(true);
    const two = [link("mbp-182", "8a1f02c4be9d7713", 2), ...one];
    const ambiguous = pickLaptopLink(two, "laptop");
    expect("error" in ambiguous && ambiguous.error).toContain("2 laptops are linked to this host: mbp-182 (8a1f02c4), mbp-2 (3d5c7f9b)");
    expect((pickLaptopLink(two, "MBP-2") as { link: LaptopLink }).link.device).toBe("3d5c7f9b6bd74d35");
    expect((pickLaptopLink(two, "8a1f") as { link: LaptopLink }).link.laptop).toBe("mbp-182");
    expect("error" in pickLaptopLink(two, "nose")).toBe(true);
    expect((pickLaptopLink([], "laptop") as { error: string }).error).toContain("no laptop is linked");
  });

  test("only the session owner's laptops count, and a laptop too old for its own file still does through the legacy one", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-link-owner-"));
    fs.mkdirSync(path.join(home, "laptop-links"), { recursive: true });
    fs.writeFileSync(path.join(home, "laptop-links/deva.json"), JSON.stringify(link("mine", "deva", 1)));
    fs.writeFileSync(path.join(home, "laptop-links/devb.json"), JSON.stringify(link("theirs", "devb", 3, "u2")));
    fs.writeFileSync(path.join(home, "laptop-link.json"), JSON.stringify(link("old", undefined, 2)));
    expect(readLaptopLinks(home, "u1").map((l) => l.laptop)).toEqual(["old", "mine"]);
    // The legacy file repeating a laptop that has its own file is not a second laptop.
    fs.writeFileSync(path.join(home, "laptop-link.json"), JSON.stringify(link("mine", "deva", 1)));
    expect(readLaptopLinks(home, "u1").map((l) => l.laptop)).toEqual(["mine"]);
  });
});

describe("the link connection", () => {
  test("its remote side writes the link file 0600 from stdin and removes it when the connection ends", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-link-home-"));
    const child = spawn("bash", ["-c", browserLinkRemote("dev1")], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "pipe"] });
    const file = path.join(home, ".codecast/browser/laptop-links/dev1.json");
    const legacy = path.join(home, ".codecast/browser/laptop-link.json");
    child.stdin.write('{"v":1}\n');
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(fs.readFileSync(file, "utf-8")).toBe('{"v":1}\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(legacy, "utf-8")).toBe('{"v":1}\n');
    const exited = new Promise<number | null>((r) => child.once("exit", r));
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
  }, 30_000);

  test("a line after the first is the laptop's closing reason, kept once the link file goes; a new link clears it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-link-home-"));
    const dir = path.join(home, ".codecast/browser");
    const run = () => spawn("bash", ["-c", browserLinkRemote("dev1")], { env: { ...process.env, HOME: home }, stdio: ["pipe", "ignore", "pipe"] });
    const own = path.join(dir, "laptop-links/dev1.json");
    const waitFor = async (f: string) => { const d = Date.now() + 20_000; while (!fs.existsSync(f) && Date.now() < d) await new Promise((r) => setTimeout(r, 20)); };
    const closed = { v: 1, reason: "revoked", laptop: "mbp", hostId: "i-1", at: 1 };
    const a = run();
    a.stdin.write('{"v":1}\n');
    await waitFor(own);
    a.stdin.end(`${JSON.stringify(closed)}\n`);
    expect(await new Promise<number | null>((r) => a.once("exit", r))).toBe(0);
    expect(fs.existsSync(own)).toBe(false);
    expect(readLaptopLinkClosed(dir)).toEqual(closed as any);
    expect(fs.readdirSync(path.join(dir, "laptop-links"))).toEqual(["dev1.closed.json"]);

    const b = run();
    b.stdin.write('{"v":1}\n');
    await waitFor(own);
    expect(readLaptopLinkClosed(dir)).toBeNull();
    b.stdin.end();
    expect(await new Promise<number | null>((r) => b.once("exit", r))).toBe(0);
    expect(fs.readdirSync(path.join(dir, "laptop-links"))).toEqual([]);
    expect(fs.existsSync(path.join(dir, "laptop-link.json"))).toBe(false);
  }, 45_000);

  test("forwards the bridge port to the laptop's own host port, fails on a taken one, and never links a shared host", () => {
    const args = browserLinkArgs({ address: "h", user: "u", keyPath: "/k", remoteBaseDir: "/w" }, 41729, "dev1");
    expect(args).toContain(`127.0.0.1:${linkHostPort("dev1")}:127.0.0.1:41729`);
    expect(() => browserLinkRemote("a; rm -rf ~")).toThrow();
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

describe("a request that arrives through a laptop link", () => {
  /** The bridge's answer to /status with this Host header: what a cloud host's client sends through its reverse forward. */
  const statusWithHost = async (port: number, token: string, hostHeader: string): Promise<number> => {
    const net = await import("node:net");
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET /status?token=${token} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`));
      let seen = "";
      socket.on("data", (c) => { seen += c.toString("latin1"); });
      socket.on("close", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(seen)?.[1] ?? 0)));
      socket.on("error", reject);
    });
  };

  test("names the host's link port, and is answered", async () => {
    const c = newHostClient("i-link");
    const { port } = await bridgeWithHosts({ "i-link": c.record });
    expect(await statusWithHost(port, c.token, `127.0.0.1:${linkHostPort("laptop-device")}`)).toBe(200);
    expect(await statusWithHost(port, c.token, `127.0.0.1:${port}`)).toBe(200);
  });

  test("a rebound page's name, or a port outside the links, is still refused", async () => {
    const c = newHostClient("i-link");
    const { port } = await bridgeWithHosts({ "i-link": c.record });
    expect(await statusWithHost(port, c.token, `evil.example:${LINK_HOST_PORT_BASE}`)).toBe(403);
    expect(await statusWithHost(port, c.token, `127.0.0.1:${LINK_HOST_PORT_BASE + LINK_HOST_PORT_SPAN}`)).toBe(403);
  });
});
