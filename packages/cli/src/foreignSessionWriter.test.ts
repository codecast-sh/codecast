import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foreignSessionWriter, foreignWriterScreen, ForeignWriterHoldError, parsePsRows, PS_ROWS_ARGS } from "./foreignSessionWriter.js";
import { functionBlock } from "./test-helpers/sourceRegion.js";

const SID = "0a671390-b53d-4050-9ab0-c17416ea0f7a";
const DAEMON = 900;

// Shapes read off this machine's `ps -axww -o pid=,ppid=,tty=,args=` (2026-11-14).
const PS = [
  `    1     0 ??       /sbin/launchd`,
  `  900     1 ??       /Users/x/.bun/bin/bun /Users/x/.codecast/cli/main.ts _daemon`,
  // Codecast's own resume pane: per-session tmux server, shell, agent.
  `12262     1 ??       /opt/homebrew/bin/tmux -L cast-cc-resume-server-0a671390 new-session -d -x 220 -y 50 -s cc-resume-server-0a671390`,
  `12263 12262 ttys000  -bash`,
  `12291 12263 ttys000  /Users/x/.codecast/bin/claude --resume ${SID} --model opus`,
  // Codecast's Claude SDK host.
  ` 1135     1 ??       /Users/x/.bun/bin/bun /Users/x/src/codecast/packages/cli/src/main.ts _claude-sdk-host /Users/x/.codecast/claude-sdk/${SID}`,
  ` 1136  1135 ??       /Users/x/.codecast/bin/claude --output-format stream-json --verbose --input-format stream-json --resume=${SID}`,
].join("\n");

// Another app's runner: an Electron app driving a headless stream-json agent.
const OTHER_APP = [
  ` 4400     1 ??       /Applications/Runner.app/Contents/MacOS/Runner`,
  ` 4543  4400 ??       /Applications/Runner.app/Contents/Frameworks/Runner Helper.app/Contents/MacOS/Runner Helper --type=utility`,
  ` 4551  4543 ??       /Users/x/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --resume=${SID} --permission-mode=bypassPermissions`,
].join("\n");

describe("another program running the session (GitHub #88)", () => {
  test("Codecast's own panes and SDK hosts are not foreign", () => {
    expect(foreignSessionWriter(parsePsRows(PS), SID, DAEMON)).toBeNull();
  });

  test("a headless agent under another app, named by --resume=<id>, is", () => {
    const rows = parsePsRows(`${PS}\n${OTHER_APP}`);
    const writer = foreignSessionWriter(rows, SID, DAEMON);
    expect(writer?.pid).toBe(4551);
    const screen = foreignWriterScreen(writer!, rows);
    expect(screen).toContain("pid 4551");
    expect(screen).toContain("Runner.app");
  });

  test("--session-id and a person's own terminal count; another session, a fork child, or a non-agent do not", () => {
    const row = (args: string, tty = "ttys009") => parsePsRows(` 700     1 ${tty}  ${args}`);
    expect(foreignSessionWriter(row(`claude --session-id ${SID}`), SID, DAEMON)?.pid).toBe(700);
    expect(foreignSessionWriter(row(`claude --resume ${SID}`), SID, DAEMON)?.pid).toBe(700);
    expect(foreignSessionWriter(row(`claude --resume 11111111-2222-3333-4444-555555555555`), SID, DAEMON)).toBeNull();
    expect(foreignSessionWriter(row(`claude --resume ${SID} --fork-session --session-id 11111111-2222-3333-4444-555555555555`), SID, DAEMON)).toBeNull();
    expect(foreignSessionWriter(row(`grep --resume ${SID}`), SID, DAEMON)).toBeNull();
  });

  test("an agent the daemon itself spawned is not foreign", () => {
    expect(foreignSessionWriter(parsePsRows(` 701   ${DAEMON} ??  claude -p --resume ${SID}`), SID, DAEMON)).toBeNull();
  });

  test("the hold names the process and is not a failure", () => {
    const rows = parsePsRows(OTHER_APP);
    const err = new ForeignWriterHoldError(rows[2], "screen");
    expect(err.holdReason).toContain("pid 4551");
    expect(err.recheckMs).toBeGreaterThan(0);
  });
});

describe("found on the live process table", () => {
  const dir = mkdtempSync(join(tmpdir(), "i88-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a detached process with no terminal, named claude, holding the session", async () => {
    const bin = join(dir, "claude");
    writeFileSync(bin, "setTimeout(() => {}, 30_000);\n");
    // `bun …/claude`, the shape of a script-installed agent. Started in the
    // background of a shell that exits at once, so it runs under launchd with
    // no terminal, as another app's agent does, not under this test's tmux.
    const out = execFileSync("/bin/sh", ["-c", `"${process.execPath}" "${bin}" --output-format stream-json --resume=${SID} </dev/null >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
    const pid = Number(out.trim());
    try {
      await new Promise((r) => setTimeout(r, 300));
      const rows = parsePsRows(execFileSync("ps", PS_ROWS_ARGS, { encoding: "utf8" }));
      // No controlling terminal: "??" on macOS, "?" on Linux.
      expect(rows.find((r) => r.pid === pid)?.tty).toMatch(/^\?\??$/);
      expect(foreignSessionWriter(rows, SID, process.pid)?.pid).toBe(pid);
    } finally {
      process.kill(pid, "SIGKILL");
    }
  });
});

describe("the resume path checks before it touches the transcript or a pane", () => {
  const inner = functionBlock(readFileSync(new URL("./daemon.ts", import.meta.url), "utf8"), "autoResumeSessionInner").text;
  test("held with the process as its screen, ahead of transcript repair and tmux", () => {
    const at = inner.indexOf("foreignSessionWriter(rows, sessionId, process.pid)");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(inner.indexOf("awaitRecentSessionFile"));
    expect(at).toBeLessThan(inner.indexOf('"new-session"'));
    expect(inner).toContain("if (opts?.delivery) throw new ForeignWriterHoldError(writer, foreignWriterScreen(writer, rows));");
  });
  test("Send anyway and a resume the person asked for go ahead", () => {
    expect(inner).toContain("if (!opts?.userInitiated && !isForcedPastDialog(opts?.delivery?.messageId)) {");
  });
});
