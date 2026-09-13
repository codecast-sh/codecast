import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function waitForFile(path: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`process did not report readiness: ${path}`);
    await Bun.sleep(25);
  }
  return readFileSync(path, "utf8");
}

test.skipIf(!Bun.which("lsof"))("dev shutdown leaves connected browser processes alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codecast-dev-shutdown-"));
  const portFile = join(dir, "port");
  const clientFile = join(dir, "connected");
  const server = Bun.spawn([process.execPath, "-e", `const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); require("node:fs").writeFileSync(${JSON.stringify(portFile)}, String(s.port));`], { stdout: "ignore", stderr: "inherit" });
  let client: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const port = Number(await waitForFile(portFile));
    client = Bun.spawn([process.execPath, "-e", `await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); setInterval(() => {}, 1000); require("node:fs").writeFileSync(${JSON.stringify(clientFile)}, "ready");`], { stdout: "ignore", stderr: "inherit" });
    expect(await waitForFile(clientFile)).toBe("ready");
    const source = await Bun.file(process.env.DEV_SH_UNDER_TEST ?? new URL("../../dev.sh", import.meta.url)).text();
    const cleanup = source.match(/kill_port\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(cleanup).toBeDefined();
    const shell = Bun.spawn(["bash", "-c", `log() { :; }\nlog_err() { :; }\n${cleanup}\nkill_port "$1"`, "dev-shutdown-test", String(port)], { stdout: "pipe", stderr: "pipe" });
    expect(await shell.exited).toBe(0);
    await server.exited;
    expect(server.signalCode).toBe("SIGTERM");
    expect(client.exitCode).toBeNull();
    expect(client.signalCode).toBeNull();
  } finally {
    if (client?.exitCode === null) client.kill();
    if (server.exitCode === null) server.kill();
    await Promise.all([client?.exited, server.exited]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
