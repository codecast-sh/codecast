import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { freePort } from "../instance.js";
import { serveBridge, type BridgeSocket } from "./transport.js";

const children: ChildProcess[] = [];
const servers: Awaited<ReturnType<typeof serveBridge>>[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  for (const server of servers.splice(0)) await server.close();
});

async function setup(limits: { socketBudget?: number; serverBudget?: number } = {}) {
  const port = await freePort();
  const sockets: BridgeSocket[] = [];
  const server = await serveBridge({
    port, maxPayload: 64 * 1024 * 1024, ...limits,
    fetch: async () => new Response("healthy"),
    upgrade: () => socket => { sockets.push(socket); },
  });
  servers.push(server);
  return { port, sockets, server };
}

async function peer(port: number, expected: number) {
  const child = spawn(process.execPath, [`${import.meta.dir}/transport.peer.ts`, String(port), String(expected)], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { output += String(chunk); });
  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`peer exited: ${child.exitCode}/${child.signalCode}: ${output}`);
    return output.includes("ready");
  });
  return { child, output: () => output };
}

async function waitFor(check: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await Bun.sleep(10);
  }
}

const frame = (sequence: number) => Buffer.from(JSON.stringify({ sequence, text: "x".repeat(256 * 1024) }));

test.skipIf(process.platform === "win32")("a resumed reader gets every queued text frame exactly once and releases the queue", async () => {
  const { port, sockets, server } = await setup();
  const client = await peer(port, 128);
  client.child.kill("SIGSTOP");
  for (let i = 0; i < 128; i++) sockets[0].send(frame(i));
  expect(server.stats().bufferedBytes).toBeGreaterThan(0);
  expect(await fetch(`http://127.0.0.1:${port}/`).then(r => r.text())).toBe("healthy");
  client.child.kill("SIGCONT");
  await waitFor(() => client.output().includes("received"));
  await waitFor(() => server.stats().bufferedBytes === 0);
  expect(client.output()).not.toContain("error:");
  expect(server.stats().overflows).toBe(0);
  expect(server.stats().sockets).toBe(1);
}, 20_000);

test.skipIf(process.platform === "win32")("a stopped peer is bounded and disconnected without affecting a healthy peer", async () => {
  const { port, sockets, server } = await setup({ socketBudget: 1024 * 1024 });
  const slow = await peer(port, 1000);
  const healthy = await peer(port, 1);
  slow.child.kill("SIGSTOP");
  for (let i = 0; i < 128 && sockets[0].readyState === 1; i++) sockets[0].send(frame(i));
  expect(sockets[0].readyState).toBe(3);
  expect(server.stats().overflows).toBe(1);
  expect(server.stats().bufferedBytes).toBe(0);
  sockets[1].send(frame(0));
  await waitFor(() => healthy.output().includes("received"));
  expect(server.stats().sockets).toBe(1);
}, 20_000);

test.skipIf(process.platform === "win32")("the whole-server budget bounds several slow peers together", async () => {
  const { port, sockets, server } = await setup({ socketBudget: 8 * 1024 * 1024, serverBudget: 1024 * 1024 });
  for (let i = 0; i < 3; i++) (await peer(port, 1000)).child.kill("SIGSTOP");
  for (let sequence = 0; sequence < 128; sequence++) {
    for (const socket of sockets) socket.send(frame(sequence));
    expect(server.stats().bufferedBytes).toBeLessThanOrEqual(1024 * 1024);
  }
  expect(server.stats().overflows).toBe(3);
  expect(server.stats().sockets).toBe(0);
}, 20_000);

test("shutdown releases the listening port", async () => {
  const { port, server } = await setup();
  await server.close();
  const replacement = await serveBridge({ port, maxPayload: 1024, fetch: async () => new Response("replacement"), upgrade: () => new Response(null, { status: 403 }) });
  servers.push(replacement);
  expect(await fetch(`http://127.0.0.1:${port}/`).then(r => r.text())).toBe("replacement");
});
