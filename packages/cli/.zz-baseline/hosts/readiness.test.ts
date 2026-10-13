import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("a new Mac keeps waiting for SSH beyond the Linux boot window", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mac-readiness-"));
  const bin = path.join(home, ".local/bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "aws"), `#!/bin/sh
printf '%s\\n' '{"Reservations":[{"Instances":[{"State":{"Name":"running"},"PublicIpAddress":"203.0.113.1"}]}]}'
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
case "$*" in *' -O exit '*) exit 0;; esac
count=$(cat "$HOME/ssh-count" 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" > "$HOME/ssh-count"
[ "$count" -ge 3 ]
`, { mode: 0o755 });
  const script = path.join(home, "run.ts");
  fs.writeFileSync(script, `
import { ensureUp, writeHosts } from ${JSON.stringify(path.resolve(import.meta.dir, "../browser/cloudHost.ts"))};
const host = { id: "i-test", provider: "aws", region: "us-east-2", platform: "darwin", user: "ec2-user", keyPath: "/unused" } as const;
writeHosts([host]);
let now = Date.now();
Date.now = () => now;
globalThis.setTimeout = ((callback: () => void) => { now += 180_000; queueMicrotask(callback); return 0; }) as typeof setTimeout;
const result = await ensureUp(host);
console.log(result.address);
`);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, HOME: home, CODECAST_DIR: path.join(home, "state"), PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("203.0.113.1");
    expect(fs.readFileSync(path.join(home, "ssh-count"), "utf8")).toBe("3");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
