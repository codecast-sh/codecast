import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";

// `cast start` on a machine with the LaunchAgent installed must make launchd
// actually spawn the daemon, and must not claim success when it did not.
//
// launchd bootstrap is a no-op on a job it already has loaded, and it holds a
// loaded KeepAlive job whose recent runs all crashed in a pended state instead
// of respawning it. With bootstrap alone, `cast start` did nothing and then
// printed "Daemon started" after its 5s poll timed out — the daemon stayed dead
// for 90 minutes on 2026-09-15 until someone ran kickstart by hand.
//
// A source scan, because startDaemon is inline in the CLI module tail and
// cannot be imported without running the CLI.

const source = fs.readFileSync(path.join(import.meta.dir, "index.ts"), "utf-8");

/** The body of `function <name>(...)`, by brace balance from its opening `{`. */
function functionBody(name: string): string {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced body for ${name}`);
}

describe("startDaemon under launchd", () => {
  const body = functionBody("startDaemon");

  test("kickstarts a loaded job instead of relying on bootstrap", () => {
    expect(body).toContain("kickstartManagedDaemon()");
    expect(functionBody("kickstartManagedDaemon")).toContain('"kickstart"');
  });

  test("reports success only after the launchd pid is observed", () => {
    // One print inside the poll loop (pid seen) plus one on the spawn path;
    // none after the launchd poll gives up.
    const launchdBranch = body.slice(body.indexOf("managedPlistPath && launchdUid"), body.indexOf("let child"));
    expect(launchdBranch.match(/console\.log\("Daemon started"\)/g)?.length).toBe(1);
    expect(launchdBranch).toContain("process.exitCode = 1");
  });
});

describe("_watchdog pass", () => {
  test("exits the process explicitly after the pass", () => {
    // daemon.js arms module-level timers at import, so without an explicit
    // exit the shell watchdog loop waits on a finished pass forever.
    const at = source.indexOf('.command("_watchdog"');
    expect(at).toBeGreaterThan(-1);
    const action = source.slice(at, source.indexOf("});", source.indexOf("await runWatchdog()", at)));
    expect(action).toContain("process.exit(0)");
    expect(action).toContain("process.exit(1)");
  });
});
