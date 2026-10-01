import { afterEach, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { freePort } from "../instance.js";
import { serveBridge, type BridgeSocket } from "./transport.js";

const peers: Socket[] = [];
const servers: Awaited<ReturnType<typeof serveBridge>>[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
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

async function peer(port: number) {
  const socket = connect(port, "127.0.0.1");
  peers.push(socket);
  let ready = false;
  let buffered = Buffer.alloc(0);
  const sequences: number[] = [];
  const opcodes: number[] = [];
  socket.on("connect", () => socket.write([
    "GET / HTTP/1.1", `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: MDEyMzQ1Njc4OWFiY2RlZg==", "", "",
  ].join("\r\n")));
  socket.on("data", chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    if (!ready) {
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      expect(buffered.toString("utf8", 0, end)).toStartWith("HTTP/1.1 101");
      ready = true;
      buffered = buffered.subarray(end + 4);
    }
    while (buffered.length >= 2) {
      let size = buffered[1] & 127;
      const header = size === 127 ? 10 : size === 126 ? 4 : 2;
      if (buffered.length < header) return;
      if (size === 127) size = Number(buffered.readBigUInt64BE(2));
      else if (size === 126) size = buffered.readUInt16BE(2);
      if (buffered.length < header + size) return;
      opcodes.push(buffered[0]);
      if (buffered[0] === 0x81) sequences.push(JSON.parse(buffered.toString("utf8", header, header + size)).sequence);
      buffered = buffered.subarray(header + size);
    }
  });
  await waitFor(() => ready);
  return { socket, sequences, opcodes };
}

async function waitFor(check: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await Bun.sleep(10);
  }
}

const frame = (sequence: number) => Buffer.from(JSON.stringify({ sequence, text: "x".repeat(256 * 1024) }));

test("a resumed reader gets every queued text frame exactly once and releases the queue", async () => {
  const { port, sockets, server } = await setup();
  const client = await peer(port);
  client.socket.pause();
  for (let i = 0; i < 128; i++) sockets[0].send(frame(i));
  expect(server.stats().bufferedBytes).toBeGreaterThan(0);
  expect(await fetch(`http://127.0.0.1:${port}/`).then(r => r.text())).toBe("healthy");
  client.socket.resume();
  await waitFor(() => client.sequences.length === 128);
  await waitFor(() => server.stats().bufferedBytes === 0);
  expect(client.sequences).toEqual(Array.from({ length: 128 }, (_, i) => i));
  expect(client.opcodes.every(code => code === 0x81)).toBe(true);
  expect(server.stats().overflows).toBe(0);
  expect(server.stats().sockets).toBe(1);
}, 20_000);

test("a stopped peer is bounded and disconnected without affecting a healthy peer", async () => {
  const { port, sockets, server } = await setup({ socketBudget: 1024 * 1024 });
  const slow = await peer(port);
  const healthy = await peer(port);
  slow.socket.pause();
  for (let i = 0; i < 128 && sockets[0].readyState === 1; i++) sockets[0].send(frame(i));
  expect(sockets[0].readyState).toBe(3);
  expect(server.stats().overflows).toBe(1);
  expect(server.stats().bufferedBytes).toBe(0);
  sockets[1].send(frame(0));
  await waitFor(() => healthy.sequences.length === 1);
  expect(server.stats().sockets).toBe(1);
}, 20_000);

test("the whole-server budget bounds several slow peers together", async () => {
  const { port, sockets, server } = await setup({ socketBudget: 8 * 1024 * 1024, serverBudget: 1024 * 1024 });
  for (let i = 0; i < 3; i++) (await peer(port)).socket.pause();
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

test("a full shared budget evicts a slow queue instead of a healthy sender", async () => {
  const { port, sockets, server } = await setup({ socketBudget: 8 * 1024 * 1024, serverBudget: 1024 * 1024 });
  const slow = await peer(port);
  const healthy = await peer(port);
  slow.socket.pause();
  for (let i = 0; i < 128 && server.stats().bufferedBytes < 512 * 1024; i++) sockets[0].send(frame(i));
  expect(server.stats().bufferedBytes).toBeGreaterThanOrEqual(512 * 1024);
  sockets[1].send(JSON.stringify({ sequence: 0, text: "x".repeat(600 * 1024) }));
  await waitFor(() => healthy.sequences.length === 1);
  expect(sockets[0].readyState).toBe(3);
  expect(sockets[1].readyState).toBe(1);
  expect(server.stats().overflows).toBe(1);
});
