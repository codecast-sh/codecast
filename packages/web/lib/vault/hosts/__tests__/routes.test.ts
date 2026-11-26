import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  _resetHostRoutesForTests,
  hostEndpoint,
  hostOfEndpoint,
  hostOfVault,
  hostVaultId,
  routeEndpoint,
  setHostEndpoint,
  setHostEstablisher,
  setLocalEndpoint,
} from "../routes";
import { listVaults, locateVault, loopbackFetch, readVaultFile, subscribeVaultEvents, vaultAssetUrl, writeVaultFile } from "../../client";
import { LspWebSocketTransport } from "../../../code/lsp/transport";
import { fetchBlame, fetchGitBase, fetchGitStatus, fetchVimrcText, searchCode } from "../../../code/daemonClient";
import { counterpartPath, hostPathFor, vaultsOn } from "../hostVaults";

const local = { port: 40001, token: "local-token", deviceId: "laptop", tmux: true };
const host = { port: 45001, token: "host-token", deviceId: "cloud", tmux: true };
const reopened = { port: 45002, token: "host-token", deviceId: "cloud", tmux: true };
/** A vault on the cloud host, as this window names it. */
const HOSTREPO = hostVaultId("hostrepo", "cloud");

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
  // A buffer saved after the person moved back to a local vault still holds the local endpoint.
  await readVaultFile(local, HOSTREPO, "src/a.ts");
  await writeVaultFile(local, HOSTREPO, "src/a.ts", "new", "e1");
  for await (const _ of searchCode(local, HOSTREPO, "needle")) void _;
  await fetchGitStatus(local, HOSTREPO);
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
  dead.add(host.port);
  let asked = 0;
  setHostEstablisher(async () => {
    asked++;
    return reopened;
  });
  const res = await writeVaultFile(local, HOSTREPO, "src/a.ts", "new", "e1");
  expect(res.etag).toBe("e2");
  expect(asked).toBe(1);
  expect(calls.filter((c) => c.method === "PUT").map((c) => Number(new URL(c.url).port))).toEqual([
    host.port, host.port, reopened.port,
  ]);
  // Later requests go straight to the new forward.
  await readVaultFile(local, HOSTREPO, "src/a.ts");
  expect(Number(new URL(calls.at(-1)!.url).port)).toBe(reopened.port);
});

test("a refused request is not retried when reopening yields the same port: it may have reached the host", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  dead.add(host.port);
  setHostEstablisher(async () => host);
  await expect(writeVaultFile(local, HOSTREPO, "a.ts", "x", "e1")).rejects.toThrow("Failed to fetch");
  expect(calls.filter((c) => c.method === "PUT").every((c) => Number(new URL(c.url).port) === host.port)).toBe(true);
});

test("a host that cannot be reached again surfaces the failure and drops its forward", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  dead.add(host.port);
  setHostEstablisher(async () => null);
  await expect(readVaultFile(local, HOSTREPO, "a.ts")).rejects.toThrow();
  expect(hostEndpoint("cloud")).toBeNull();
  // The dead endpoint is still the host's, so a later use reopens a forward
  // rather than taking it for this machine.
  expect(hostOfEndpoint(host)).toBe("cloud");
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
  let asked = 0;
  setHostEstablisher(async () => {
    asked++;
    return reopened;
  });
  const ups: number[] = [];
  const dispose = subscribeVaultEvents(local, HOSTREPO, { onEvent: () => {}, onUp: () => ups.push(1) });
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
  const vaults = [v("l-app", "/Users/ada/src/app"), v("l-notes", "/Users/ada/notes"), v("h-app@cloud", "/home/ubuntu/work/app")];
  expect(vaultsOn(vaults, null).map((x) => x.id)).toEqual(["l-app", "l-notes"]);
  expect(vaultsOn(vaults, "cloud").map((x) => x.id)).toEqual(["h-app@cloud"]);
  expect(counterpartPath("/home/ubuntu/work/app/src/x.ts", "cloud", vaults)).toEqual({ deviceId: null, abs: "/Users/ada/src/app/src/x.ts" });
  expect(counterpartPath("/Users/ada/src/app/src/x.ts", null, vaults)).toEqual({ deviceId: "cloud", abs: "/home/ubuntu/work/app/src/x.ts" });
  expect(counterpartPath("/Users/ada/notes/a.md", null, vaults)).toBeNull();
  // The same folder on both machines is its own counterpart.
  const mirrored = [v("l-app", "/Users/ada/src/app"), v("h-same@cloud", "/Users/ada/src/app2")];
  expect(counterpartPath("/Users/ada/src/app2/x.ts", "cloud", [...mirrored, v("l-app2", "/Users/ada/src/app2")])).toEqual({ deviceId: null, abs: "/Users/ada/src/app2/x.ts" });
});

test("a host laid out like this machine keeps its vault apart: the same daemon id names two vaults", async () => {
  // Both daemons hash the same folder to the same id.
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  const onHost = hostVaultId("same", "cloud");
  expect(hostOfVault("same")).toBeNull();
  expect(hostOfVault(onHost)).toBe("cloud");
  await readVaultFile(local, "same", "a.ts");
  await readVaultFile(local, onHost, "a.ts");
  expect(calls.map((c) => [Number(new URL(c.url).port), new URL(c.url).searchParams.get("vault")])).toEqual([
    [local.port, "same"],
    [host.port, "same"],
  ]);
});

test("a host vault with no forward open opens one first, and never falls back to this machine's daemon", async () => {
  setLocalEndpoint(local);
  let asked = 0;
  setHostEstablisher(async () => (asked++, host));
  await readVaultFile(local, HOSTREPO, "a.ts");
  expect(asked).toBe(1);
  expect(port(0)).toBe(host.port);

  _resetHostRoutesForTests();
  setLocalEndpoint(local);
  setHostEstablisher(async () => null);
  calls = [];
  await expect(readVaultFile(local, HOSTREPO, "a.ts")).rejects.toThrow("not reachable");
  expect(calls).toHaveLength(0);
  // An image in a host note waits for the forward rather than asking this machine.
  expect(vaultAssetUrl(local, HOSTREPO, "a.png")).toBeNull();
});

test("vaults a host's daemon lists or locates come back under this window's id for them", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  const info = { id: "hostrepo", root: "/home/ubuntu/app", name: "app", added_at: 1 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/vault/roots")) return Response.json({ vaults: [info] });
    return Response.json({ vault: info, rel: "x.ts" });
  }) as typeof fetch;
  expect((await listVaults(host)).map((x) => x.id)).toEqual([HOSTREPO]);
  expect((await locateVault(host, "/home/ubuntu/app/x.ts"))?.vault.id).toBe(HOSTREPO);
  // This machine's are untouched.
  expect((await listVaults(local)).map((x) => x.id)).toEqual(["hostrepo"]);
});

test("a host socket's events arrive under this window's vault id", () => {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  const seen: string[] = [];
  const dispose = subscribeVaultEvents(local, HOSTREPO, { onEvent: (ev) => seen.push(ev.vault) });
  FakeSocket.all[0].onmessage?.({ data: JSON.stringify({ type: "reset", vault: "hostrepo" }) });
  expect(seen).toEqual([HOSTREPO]);
  dispose();
});

test("a host vault's language server runs on the host: its forward, the daemon's vault id", async () => {
  FakeSocket.all = [];
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  const t = new LspWebSocketTransport({
    vaultId: HOSTREPO,
    server: "typescript",
    endpoint: () => local,
    WebSocket: FakeSocket as unknown as new (url: string) => WebSocket,
  });
  await new Promise((r) => setTimeout(r, 0));
  const ws = FakeSocket.all[0];
  expect(ws.url).toBe(`ws://127.0.0.1:${host.port}/lsp/ws`);
  ws.onopen?.();
  expect(JSON.parse(ws.sent[0])).toMatchObject({ type: "hello", token: "host-token", vault: "hostrepo", server: "typescript" });
  t.dispose();
});

test("a local vault's requests go to this machine while a host vault is active, whatever endpoint the caller holds", async () => {
  // The active vault is on the host, so the store's endpoint is the host's;
  // a local buffer saved now (save-all, an editor unmounting) must not land on
  // the host, where a vault with the same daemon id may hold the same path.
  FakeSocket.all = [];
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  expect(routeEndpoint(host, "same")).toBe(local);
  await readVaultFile(host, "same", "a.ts");
  await writeVaultFile(host, "same", "a.ts", "new", "e1");
  for await (const _ of searchCode(host, "same", "needle")) void _;
  await fetchGitStatus(host, "same");
  await fetchGitBase(host, "same", "a.ts");
  await fetchBlame(host, "same", "a.ts");
  expect(calls.map((c) => [Number(new URL(c.url).port), c.auth])).toEqual(
    Array.from({ length: 6 }, () => [local.port, "Bearer local-token"]),
  );
  const t = new LspWebSocketTransport({
    vaultId: "same",
    server: "typescript",
    endpoint: () => host,
    WebSocket: FakeSocket as unknown as new (url: string) => WebSocket,
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(FakeSocket.all[0].url).toBe(`ws://127.0.0.1:${local.port}/lsp/ws`);
  t.dispose();
});

test("a local vault's request never reopens a host's forward, and never goes to a host with no local daemon known", async () => {
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  let asked = 0;
  setHostEstablisher(async () => (asked++, reopened));
  dead.add(local.port);
  await expect(writeVaultFile(host, "same", "a.ts", "x", "e1")).rejects.toThrow("Failed to fetch");
  expect(asked).toBe(0);
  expect(calls.every((c) => Number(new URL(c.url).port) === local.port)).toBe(true);
  // This machine's daemon is not known: nowhere to go, the host is no stand-in.
  setLocalEndpoint(null);
  calls = [];
  expect(routeEndpoint(host, "same")).toBeNull();
  await expect(readVaultFile(host, "same", "a.ts")).rejects.toThrow("not connected");
  expect(calls).toHaveLength(0);
});

test("a host socket stops asking for a forward once the host is unreachable, and resumes on the next forward", async () => {
  FakeSocket.all = [];
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  setLocalEndpoint(local);
  setHostEndpoint("cloud", host);
  let asked = 0;
  setHostEstablisher(async () => (asked++, null));
  const dispose = subscribeVaultEvents(local, HOSTREPO, { onEvent: () => {} });
  FakeSocket.all[0].onclose?.();
  await new Promise((r) => setTimeout(r, 1200));
  expect(asked).toBe(1);
  // Parked: no timer keeps asking the relay and ssh.
  await new Promise((r) => setTimeout(r, 2200));
  expect(asked).toBe(1);
  expect(FakeSocket.all).toHaveLength(1);
  // The next use (a read, the header's chip) opens a forward: the socket follows.
  setHostEndpoint("cloud", reopened);
  expect(FakeSocket.all).toHaveLength(2);
  expect(FakeSocket.all[1].url).toBe(`ws://127.0.0.1:${reopened.port}/vault/ws`);
  dispose();
});

test("a host language server parks while the host is unreachable and resumes on the next forward", async () => {
  FakeSocket.all = [];
  setLocalEndpoint(local);
  let asked = 0;
  setHostEstablisher(async () => (asked++, null));
  const t = new LspWebSocketTransport({
    vaultId: HOSTREPO,
    server: "typescript",
    endpoint: () => local,
    WebSocket: FakeSocket as unknown as new (url: string) => WebSocket,
    retryInitialMs: 10,
    retryMaxMs: 20,
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(asked).toBe(1);
  expect(FakeSocket.all).toHaveLength(0);
  setHostEndpoint("cloud", host);
  await new Promise((r) => setTimeout(r, 0));
  expect(FakeSocket.all[0]?.url).toBe(`ws://127.0.0.1:${host.port}/lsp/ws`);
  t.dispose();
});

test("from a checkout standing in for a host, the way back names the host's own path for the open file", () => {
  const hostAbs = "/home/ubuntu/work/app/src/retry.ts";
  expect(hostPathFor(hostAbs, "/Users/ada/src/app", "docs/plan.md")).toBe("/home/ubuntu/work/app/docs/plan.md");
  expect(hostPathFor(hostAbs, "/Users/ada/src/app/", null)).toBe("/home/ubuntu/work/app");
  // The same layout on both machines.
  expect(hostPathFor("/Users/ada/src/app/x.ts", "/Users/ada/src/app", "y.ts")).toBe("/Users/ada/src/app/y.ts");
  // A checkout the remap did not produce: the link's own path.
  expect(hostPathFor(hostAbs, "/Users/ada/notes", "a.md")).toBe(hostAbs);
});
