import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHmac, webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../../../browser-extension/background.js', import.meta.url), 'utf8');
const statusSource = readFileSync(new URL('../../../browser-extension/status.js', import.meta.url), 'utf8');

function worker() {
  let config = { token: 'paired-token', port: 41729 };
  let reads = 0;
  let stalled = false;
  let message: (msg: object, sender: object, reply: () => void) => void;
  const sockets: Socket[] = [];
  const event = () => ({ addListener() {} });
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 0;
    sent: Array<{ nonce: string }> = [];
    onopen!: () => Promise<void>;
    onmessage!: (event: { data: string }) => Promise<void>;
    onclose!: (event: { code: number; reason: string }) => void;
    constructor(readonly url: string) { sockets.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  const chrome = {
    storage: {
      local: { get: async (key: string) => {
        if (key !== 'bridge') return {};
        reads++;
        if (stalled) return new Promise(() => {});
        return { bridge: config };
      }, set: async () => {} },
      session: { get: async () => ({}), set: async () => {} },
    },
    runtime: { onStartup: event(), onInstalled: event(), getManifest: () => ({ version: '0.1.0' }),
      onMessage: { addListener(fn: typeof message) { message = fn; } } },
    action: { setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: async () => {}, onAlarm: event() },
    tabGroups: { query: async () => [], onCreated: event(), onUpdated: event(), onRemoved: event() },
    tabs: { query: async () => [], onCreated: event(), onUpdated: event(), onRemoved: event() },
    debugger: { onEvent: event(), onDetach: event() },
  };
  const context = vm.createContext({ chrome, WebSocket: Socket, crypto: webcrypto, TextEncoder,
    navigator: { userAgent: 'test' }, importScripts() {},
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(statusSource, context);
  vm.runInContext(source, context);
  return {
    context, sockets, reads: () => reads,
    stall: () => { stalled = true; },
    changeConfig: () => { config = { token: 'new-pairing', port: 41730 }; },
    message: (op: string) => message({ op }, {}, () => {}),
    async prove() {
      const sock = sockets.at(-1)!;
      sock.readyState = Socket.OPEN;
      await sock.onopen();
      const proof = createHmac('sha256', config.token).update(sock.sent[0].nonce).digest('hex');
      await sock.onmessage({ data: JSON.stringify({ op: 'welcome', proof }) });
      return sock;
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('extension connection recovery', () => {
  test('a delayed wake preserves the connection the worker already proved', async () => {
    const w = worker();
    await settle();
    const sock = await w.prove();
    w.message('wake');
    await settle();
    expect(sock.readyState).toBe(1);
    expect(w.sockets).toHaveLength(1);
  });

  test('retries use the saved pairing when Chrome storage stops answering', async () => {
    const w = worker();
    await settle();
    const sock = await w.prove();
    w.stall();
    sock.close();
    sock.onclose({ code: 1006, reason: '' });
    await w.context.connect('retry');
    expect(w.sockets).toHaveLength(2);
    expect(w.reads()).toBe(1);
  }, 1000);

  test('an alarm on a connected worker does not read storage again', async () => {
    const w = worker();
    await settle();
    await w.prove();
    await w.context.connect('alarm');
    expect(w.reads()).toBe(1);
  });

  test('the settings reconnect refreshes pairing before opening a new socket', async () => {
    const w = worker();
    await settle();
    await w.prove();
    w.changeConfig();
    w.message('reconnect');
    await settle();
    expect(w.sockets.at(-1)?.url).toBe('ws://127.0.0.1:41730/ext');
    expect(w.reads()).toBe(2);
    await w.prove();
    expect(vm.runInContext('hostProven', w.context)).toBe(true);
  });
});
