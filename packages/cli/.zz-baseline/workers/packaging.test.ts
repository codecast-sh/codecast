import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerHost } from "./host.js";
const built = process.env.F1_WORKER_BUILT_DIR;
for (const runtime of ["node", "bun", "compiled"]) {
  test.skipIf(!built)(`actual ${runtime} packaged main entry runs worker only`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-package-"));
    const command = runtime === "compiled" ? path.join(built!, "codecast") : runtime === "bun" ? process.execPath : "node";
    const args = runtime === "compiled" ? ["_worker", "probe"] : [path.join(built!, "js/main.js"), "_worker", "probe"];
    const host = new WorkerHost("probe", { invocation: { command, args }, env: { ...process.env, CODECAST_CONFIG_DIR: dir } });
    try {
      expect(await host.request("ping", null, { timeoutMs: 10000 })).toBe("pong");
      const result: any = await host.request("read", { operation: "ps", args: ["-p", String(process.pid), "-o", "command="], options: { timeout: 5000 } });
      expect(result.status).toBe(0); expect(result.stdout).toContain("bun");
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally { host.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 15000);
}
