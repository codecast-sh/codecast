import { expect, test } from "bun:test";

test.skipIf(!Bun.which("lsof"))("dev shutdown leaves connected browser processes alive", async () => {
  const portReady = Promise.withResolvers<number>();
  const server = Bun.spawn([process.execPath, "-e", 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); process.send(s.port);'], { stdout: "ignore", stderr: "inherit", ipc: port => portReady.resolve(port) });
  console.error("listener process", process.execPath, server.pid, server.spawnargs);
  let client: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const port = await portReady.promise;
    const connected = Promise.withResolvers<string>();
    client = Bun.spawn([process.execPath, "-e", `await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); setInterval(() => {}, 1000); process.send("ready");`], { stdout: "ignore", stderr: "inherit", ipc: message => connected.resolve(message) });
    expect(await connected.promise).toBe("ready");
    const source = await Bun.file(process.env.DEV_SH_UNDER_TEST ?? new URL("../../dev.sh", import.meta.url)).text();
    const cleanup = source.match(/kill_port\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(cleanup).toBeDefined();
    const shell = Bun.spawn(["bash", "-c", `log() { :; }\nlog_err() { :; }\n${cleanup}\nkill_port "$1"`, "dev-shutdown-test", String(port)], { stdout: "pipe", stderr: "pipe" });
    expect(await shell.exited).toBe(0);
    expect(server.exitCode).not.toBeNull();
    expect(client.exitCode).toBeNull();
  } finally {
    if (client?.exitCode === null) client.kill();
    if (server.exitCode === null) server.kill();
  }
}, 30_000);
