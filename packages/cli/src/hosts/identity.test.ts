import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readHostDeviceId } from "../cloud/prepare";

test("host identity works before an SSH login has the user's CLI on PATH", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "host-identity-"));
  try {
    fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
    fs.writeFileSync(path.join(home, ".local/bin/cast"), '#!/bin/sh\necho "this device: macOS - Mac  (0123456789abcdef)"\n', { mode: 0o755 });
    let status: number | undefined;
    let stderr = "";
    const result = readHostDeviceId({ address: "test", user: "codecast", keyPath: "/unused", remoteBaseDir: "/Users/codecast/work" }, (_host, command) => {
      const shell = Bun.spawnSync(["/bin/sh", "-c", command], {
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" }, timeout: 60_000,
      });
      status = shell.exitCode;
      stderr = shell.stderr.toString();
      return shell.stdout.toString();
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(result).toBe("0123456789abcdef");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
