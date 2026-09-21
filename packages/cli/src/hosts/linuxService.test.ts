import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { daemonUnitScript } from "../browser/provisionLinux";

test.each([false, true])("Linux provisioning takes over a standalone daemon without killing service-owned tmux (tmux=%s)", async (tmux) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linux-service-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  const put = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  put("sudo", 'exec "$@"');
  put("sleep", "exit 0");
  put("cast", 'test "$1" = stop\necho stop-daemon >> "$HOME/events"\nrm "$HOME/standalone"');
  put("systemctl", `case "$1" in
cat) exit 0;;
stop) echo stop-service >> "$HOME/events";;
daemon-reload) exit 0;;
enable) echo enable-service >> "$HOME/events"; test ! -e "$HOME/standalone" && touch "$HOME/active";;
is-active) echo check-active >> "$HOME/events"; test -f "$HOME/active";;
*) exit 1;;
esac`);
  fs.writeFileSync(path.join(home, "standalone"), "fixture");
  fs.writeFileSync(path.join(home, "procs"), tmux ? "10\n" : "");
  fs.mkdirSync(path.join(home, "proc/10"), { recursive: true });
  fs.writeFileSync(path.join(home, "proc/10/comm"), "tmux: server\n");
  const script = daemonUnitScript()
    .replaceAll("/etc/systemd/system/codecast-daemon.service", path.join(home, "unit"))
    .replaceAll("/usr/local/bin/cast", path.join(bin, "cast"))
    .replace("/sys/fs/cgroup/system.slice/codecast-daemon.service/cgroup.procs", path.join(home, "procs"))
    .replace("/proc/$p/comm", `${home}/proc/$p/comm`);
  try {
    const child = Bun.spawn(["bash", "-s"], { env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` }, stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(status).toBe(tmux ? 1 : 0);
    if (tmux) {
      expect(stderr).toContain("finish those sessions");
      expect(fs.existsSync(path.join(home, "events"))).toBe(false);
      expect(fs.existsSync(path.join(home, "standalone"))).toBe(true);
    } else {
      expect(stderr).toBe("");
      expect(stdout).toContain("DAEMON-UNIT-OK");
      expect(fs.readFileSync(path.join(home, "events"), "utf8")).toBe("stop-service\nstop-daemon\nenable-service\ncheck-active\n");
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
