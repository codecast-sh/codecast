import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  _resetHostRoutesForTests,
  bindVaultToHost,
  hostOfEndpoint,
  routeEndpoint,
  setHostEndpoint,
  setHostEstablisher,
  setLocalEndpoint,
} from "../routes";
import { loopbackFetch, readVaultFile, subscribeVaultEvents, writeVaultFile } from "../../client";
import { fetchGitStatus, fetchVimrcText, searchCode } from "../../../code/daemonClient";
import { counterpartPath, vaultsOn } from "../hostVaults";

const local = { port: 40001, token: "local-token", deviceId: "laptop", tmux: true };
const host = { port: 45001, token: "host-token", deviceId: "cloud", tmux: true };
const reopened = { port: 45002, token: "host-token", deviceId: "cloud", tmux: true };

const originalFetch = globalThis.fetch;
const originalWs = globalThis.WebSocket;
let calls: { url: string; auth: string | null; method: string }[];
/** Ports that refuse connections, as a closed forward listener does. */
let dead: Set<number>;

beforeEach(() => {
  _resetHostRoutesForTests();
  calls = [];
  dead = new Set();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("Authorization"), method: init?.method ?? "GET" });
    if (dead.has(Number(new URL(url).port))) throw new TypeError("Failed to fetch");
    if (url.includes("/code/vimrc")) return new Response("{}");
    if (url.includes("/code/search")) return new Response(`{"type":"done"}\n`);
    if (url.includes("/vault/file") && init?.method === "PUT") return Response.json({ mtime: 2, size: 3, etag: "e2" });
    if (url.includes("/vault/file")) return new Response("hi", { headers: { ETag: "e1", "X-Vault-Mtime": "1", "X-Vault-Size": "2" } });
    return Response.json({ files: [], branch: "main" });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWs;
  _resetHostRoutesForTests();
});

const port = (i: number) => Number(new URL(calls[i].url).port);

test("with no cloud host every request goes to the endpoint it was given, untouched", async () => {
  setLocalEndpoint(local);
  expect(routeEndpoint(local, "repo")).toBe(local);
  await readVaultFile(local, "repo", "a.md");
  await fetchGitStatus(local, "repo");
  await fetchVimrcText(local);
  expect(calls.map((c) => [Number(new URL(c.url).port), c.auth])).toEqual([
    [local.port, "Bearer local-token"],
    [local.port, "Bearer local-token"],
    [local.port, "Bearer local-token"],
  ]);
  expect(hostOfEndpoint(local)).toBeNull();
});

test("a host vault's reads, writes, search and git go to the host's forward, whatever endpoint the caller holds", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  bindVaultToHost("hostrepo", "cloud");
  // A buffer saved after the person moved back to a local vault still holds the local endpoint.
  await readVaultFile(local, "hostrepo", "src/a.ts");
  await writeVaultFile(local, "hostrepo", "src/a.ts", "new", "e1");
  for await (const _ of searchCode(local, "hostrepo", "needle")) void _;
  await fetchGitStatus(local, "hostrepo");
  expect(calls.map((c) => [Number(new URL(c.url).port), c.auth])).toEqual([
    [host.port, "Bearer host-token"],
    [host.port, "Bearer host-token"],
    [host.port, "Bearer host-token"],
    [host.port, "Bearer host-token"],
  ]);
  // This machine's vaults are untouched by the binding.
  await readVaultFile(local, "repo", "a.md");
  expect(port(4)).toBe(local.port);
});

test("the vimrc is the person's own: read from this machine while a host vault is open", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  await fetchVimrcText(host);
  expect(port(0)).toBe(local.port);
});

test("an endpoint captured before a reconnect is upgraded to the host's current forward", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", reopened);
  await loopbackFetch(host, "/vault/locate?path=%2Fhome%2Fx");
  expect(port(0)).toBe(reopened.port);
});

test("a forward closed while idle is reopened on next use and the request retried once on the new port", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  bindVaultToHost("hostrepo", "cloud");
  dead.add(host.port);
  let asked = 0;
  setHostEstablisher(async () => {
    asked++;
    return reopened;
  });
  const res = await writeVaultFile(local, "hostrepo", "src/a.ts", "new", "e1");
  expect(res.etag).toBe("e2");
  expect(asked).toBe(1);
  expect(calls.filter((c) => c.method === "PUT").map((c) => Number(new URL(c.url).port))).toEqual([
    host.port, host.port, reopened.port,
  ]);
  // Later requests go straight to the new forward.
  await readVaultFile(local, "hostrepo", "src/a.ts");
  expect(Number(new URL(calls.at(-1)!.url).port)).toBe(reopened.port);
});

test("a refused request is not retried when reopening yields the same port: it may have reached the host", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  bindVaultToHost("hostrepo", "cloud");
  dead.add(host.port);
  setHostEstablisher(async () => host);
  await expect(writeVaultFile(local, "hostrepo", "a.ts", "x", "e1")).rejects.toThrow("Failed to fetch");
  expect(calls.filter((c) => c.method === "PUT").every((c) => Number(new URL(c.url).port) === host.port)).toBe(true);
});

test("a host that cannot be reached again surfaces the failure and drops its forward", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  bindVaultToHost("hostrepo", "cloud");
  dead.add(host.port);
  setHostEstablisher(async () => null);
  await expect(readVaultFile(local, "hostrepo", "a.ts")).rejects.toThrow();
  expect(hostOfEndpoint(host)).toBeNull();
});

class FakeSocket {
  static all: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.onclose?.();
  }
}

test("the vault socket resubscribes through the reopened forward after a drop", async () => {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  bindVaultToHost("hostrepo", "cloud");
  let asked = 0;
  setHostEstablisher(async () => {
    asked++;
    return reopened;
  });
  const ups: number[] = [];
  const dispose = subscribeVaultEvents(local, "hostrepo", { onEvent: () => {}, onUp: () => ups.push(1) });
  const first = FakeSocket.all[0];
  expect(first.url).toBe(`ws://127.0.0.1:${host.port}/vault/ws`);
  first.onopen?.();
  expect(JSON.parse(first.sent[0])).toEqual({ type: "hello", token: "host-token", vault: "hostrepo" });
  // The SSH channel dies (laptop slept, forward closed).
  first.onclose?.();
  await new Promise((r) => setTimeout(r, 1100));
  expect(asked).toBe(1);
  const second = FakeSocket.all[1];
  expect(second.url).toBe(`ws://127.0.0.1:${reopened.port}/vault/ws`);
  second.onopen?.();
  expect(JSON.parse(second.sent[0]).vault).toBe("hostrepo");
  expect(ups).toHaveLength(2);
  dispose();
});

test("a local vault's socket never asks for a forward", async () => {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  setLocalEndpoint(local);
  let asked = 0;
  setHostEstablisher(async () => {
    asked++;
    return reopened;
  });
  const dispose = subscribeVaultEvents(local, "repo", { onEvent: () => {} });
  FakeSocket.all[0].onclose?.();
  await new Promise((r) => setTimeout(r, 1100));
  expect(asked).toBe(0);
  expect(FakeSocket.all[1].url).toBe(`ws://127.0.0.1:${local.port}/vault/ws`);
  dispose();
});

const v = (id: string, root: string) => ({ id, root, name: root.split("/").pop()!, added_at: 1 });

test("vaults are scoped to their machine, and a repo maps to its same-named checkout on the other one", () => {
  bindVaultToHost("h-app", "cloud");
  const vaults = [v("l-app", "/Users/ada/src/app"), v("l-notes", "/Users/ada/notes"), v("h-app", "/home/ubuntu/work/app")];
  expect(vaultsOn(vaults, null).map((x) => x.id)).toEqual(["l-app", "l-notes"]);
  expect(vaultsOn(vaults, "cloud").map((x) => x.id)).toEqual(["h-app"]);
  expect(counterpartPath("/home/ubuntu/work/app/src/x.ts", "cloud", vaults)).toEqual({ deviceId: null, abs: "/Users/ada/src/app/src/x.ts" });
  expect(counterpartPath("/Users/ada/src/app/src/x.ts", null, vaults)).toEqual({ deviceId: "cloud", abs: "/home/ubuntu/work/app/src/x.ts" });
  expect(counterpartPath("/Users/ada/notes/a.md", null, vaults)).toBeNull();
  // The same folder on both machines is its own counterpart.
  const mirrored = [v("l-app", "/Users/ada/src/app"), v("h-same", "/Users/ada/src/app2")];
  bindVaultToHost("h-same", "cloud");
  expect(counterpartPath("/Users/ada/src/app2/x.ts", "cloud", [...mirrored, v("l-app2", "/Users/ada/src/app2")])).toEqual({ deviceId: null, abs: "/Users/ada/src/app2/x.ts" });
});
