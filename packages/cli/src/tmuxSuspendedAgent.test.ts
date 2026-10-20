import { expect, test } from "bun:test";
import { terminalProcesses, suspendedAgent, restoreSuspendedAgent } from "./tmuxSuspendedAgent";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const id = "063a7e57-39b3-44ad-a19c-347484b6829e";
const rows = terminalProcesses(`11907 11906 11907 11907 Ss+ -bash\n11955 11907 11955 11907 T /bin/claude --resume ${id}`);

test("recognizes a suspended session while its shell owns the terminal", () => {
  expect(suspendedAgent(rows, 11907, id)?.pid).toBe(11955);
  for (const patch of [{ state: "S" }, { ppid: 1 }, { foreground: 11955 }, { command: "/bin/claude --resume another" }]) {
    expect(suspendedAgent([rows[0], { ...rows[1], ...patch }], 11907, id)).toBeUndefined();
  }
  expect(suspendedAgent([...rows, { ...rows[1], pid: 12345 }], 11907, id)).toBeUndefined();
  expect(suspendedAgent(rows, 11907, "';exit")).toBeUndefined();
});

test("real stopped agent regains foreground and raw input before a message is submitted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cast-stopped-"));
  let seq = 0;
  const run = async (file: string, args: string[], options = { timeout: 5000 }) => {
    const out = join(dir, `out-${seq++}`);
    const child = Bun.spawn(["/bin/bash", "-c", 'exec "$@" > "$TEST_OUT" 2> "$TEST_ERR"', "fixture", file, ...args], { signal: AbortSignal.timeout(options.timeout), env: { ...process.env, TEST_OUT: out, TEST_ERR: `${out}.err` } });
    if (await child.exited) throw new Error(readFileSync(`${out}.err`, "utf8"));
    return { stdout: readFileSync(out, "utf8") };
  };
  const tmux = (args: string[]) => run("tmux", ["-S", join(dir, "socket"), ...args], { timeout: 5000 });
  const poll = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 50; i++) { if (await fn()) return; await Bun.sleep(100); }
    throw new Error("fixture did not reach expected state: " + JSON.stringify(await tmux(["list-panes", "-t", "fixture", "-F", "#{pane_pid}:#{pane_current_command}:#{pane_width}:#{pane_height}"])) + (await tmux(["capture-pane", "-p", "-t", "fixture"])).stdout);
  };
  writeFileSync(join(dir, "agent.c"), `#include <stdio.h>\n#include <unistd.h>\n#include <termios.h>\n#include <errno.h>\nint main(int argc, char **argv) { struct termios t; tcgetattr(0,&t); cfmakeraw(&t); tcsetattr(0,TCSANOW,&t); FILE *f=fopen(argv[3],"w"); fprintf(f,"%d\\n",getpid()); fflush(f); char c; for(;;) { int n=read(0,&c,1); if(n==1) { fputc(c,f); fflush(f); } else if(n<0 && errno==EINTR) continue; else break; } }`);
  await run("cc", [join(dir, "agent.c"), "-o", join(dir, "claude")]);
  try {
    await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "fixture", "env -i PATH=/usr/bin:/bin TERM=xterm PS1='fixture$ ' /bin/bash --noprofile --norc -i"]);
    await poll(async () => (await tmux(["capture-pane", "-p", "-t", "fixture"])).stdout.includes("fixture$"));
    await tmux(["set-option", "-t", "fixture", "@codecast_session_id", id]);
    await tmux(["send-keys", "-t", "fixture", "-l", `${dir}/claude --resume ${id} ${dir}/received`]);
    await tmux(["send-keys", "-t", "fixture", "Enter"]);
    await poll(async () => Bun.file(join(dir, "received")).exists());
    const pid = Number(readFileSync(join(dir, "received"), "utf8").trim());
    process.kill(pid, "SIGSTOP");
    await poll(async () => (await tmux(["capture-pane", "-p", "-t", "fixture"])).stdout.includes("Stopped"));
    await tmux(["send-keys", "-t", "fixture", "-l", "keep my draft"]);
    await expect(restoreSuspendedAgent("fixture", tmux, run)).rejects.toThrow("not at an empty shell prompt");
    expect((await tmux(["capture-pane", "-p", "-t", "fixture"])).stdout).toContain("keep my draft");
    await tmux(["send-keys", "-t", "fixture", "C-u"]);
    expect(await restoreSuspendedAgent("fixture", tmux, run)).toBe(true);
    await tmux(["send-keys", "-t", "fixture", "-l", "original message"]);
    await tmux(["send-keys", "-t", "fixture", "Enter"]);
    await poll(async () => readFileSync(join(dir, "received"), "utf8").endsWith("original message\r"));
    expect(readFileSync(join(dir, "received"), "utf8")).toBe(`${pid}\noriginal message\r`);
    expect(await restoreSuspendedAgent("fixture", tmux, run)).toBe(false);
  } finally {
    await tmux(["kill-server"]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
