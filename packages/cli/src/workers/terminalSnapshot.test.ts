import { expect, test } from "bun:test";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { configureDaemonWorkers, closeDaemonWorkers } from "./bridge.js";
import { encodeFrame } from "./protocol.js";
import { handleTerminalHttp, terminalSessionSnapshot } from "../terminal/terminalServer.js";
test("actual terminal HTTP handler never awaits a probe and never turns a probe timeout into an empty fleet", async () => {
  let reply!: (failed?: boolean) => void;
  const host = configureDaemonWorkers(true, {
    invocation: { command: "synthetic-private-worker", args: [] },
    spawnChild() {
      const child = Object.assign(new EventEmitter(), { pid: 999999, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      child.stdin.on("data", chunk => {
        const f = JSON.parse(chunk.toString());
        expect(f.payload.operation).toBe("tmux"); expect(f.payload.args[0]).toBe("list-sessions");
        reply = (failed = false) => child.stdout.write(encodeFrame({ v: 1, kind: "probe", type: "result", id: f.id, operation: "read", result: { status: failed ? null : 0, code: failed ? "ETIMEDOUT" : undefined, signal: failed ? "SIGKILL" : null, killed: failed, stdout: failed ? "" : "cast-term-still-alive|1|0|sh|/tmp\n", stderr: "" } }));
      });
      return child as unknown as ChildProcess;
    },
    killChild() {},
  })!;
  terminalSessionSnapshot.invalidate();
  const server = http.createServer((req, res) => { handleTerminalHttp(req, res, { token: "fixture", log() {} }); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/term/sessions`;
  const get = () => fetch(url, { headers: { Origin: "https://codecast.sh", Authorization: "Bearer fixture" }, signal: AbortSignal.timeout(1000) });
  try {
    const cold = await get(); expect(cold.status).toBe(503); expect(await cold.json()).toMatchObject({ unavailable: true }); expect(host.state.pending).toBe(1);
    reply(); await terminalSessionSnapshot.refresh();
    const good = await get(); expect(good.status).toBe(200); expect((await good.json()).sessions[0].name).toBe("cast-term-still-alive");
    const refresh = terminalSessionSnapshot.refresh(); reply(true); await refresh;
    expect((await (await get()).json()).sessions[0].name).toBe("cast-term-still-alive");
    terminalSessionSnapshot.invalidate();
    const unavailable = await get(); expect(unavailable.status).toBe(503); expect((await unavailable.json()).sessions).toBeUndefined();
    reply(true); await terminalSessionSnapshot.refresh();
  } finally {
    closeDaemonWorkers(); terminalSessionSnapshot.invalidate();
    await new Promise<void>(r => server.close(() => r()));
  }
});
