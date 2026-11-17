// The broker: live reads and fake answers for the agent's guard, served from
// the harness process, outside the sandbox.
import * as fs from "node:fs";
import * as path from "node:path";
import { ctx } from "./prompt-dry-run-context.ts";
import { answerFake } from "./prompt-dry-run-fakecall.ts";
import { cliHelp, cliNoSignIn } from "./prompt-dry-run-realcast.ts";
import { loggedArgv, markCall, readKey, recordBegin, recordMark } from "./prompt-dry-run-record.ts";

/**
 * Where the broker's guard runs: a directory the agent cannot write and that
 * holds no bunfig.toml or env file. bun (and a compiled cast) runs a
 * bunfig.toml preload from its cwd, and a compiled cast loads .env from it,
 * so a cwd the agent could write would run its code outside the sandbox with
 * the real home folder. The agent's --cwd counts only when it sits outside
 * the run dir (a real checkout, read-only to the agent) and is clean; the
 * agent never chooses.
 */
function brokerCwd(): string {
  const { agentCwd, runDir, brokerCwdDefault } = ctx();
  if (!agentCwd) return brokerCwdDefault;
  const cwd = fs.realpathSync(agentCwd);
  const run = fs.realpathSync(runDir);
  const agentWritable = cwd === run || cwd.startsWith(`${run}${path.sep}`);
  const loads = ["bunfig.toml", ".env", ".env.local", ".envrc"].some((f) => fs.existsSync(path.join(cwd, f)));
  return agentWritable || loads ? brokerCwdDefault : cwd;
}

/**
 * Live reads and fake answers, outside the sandbox. The agent cannot read the
 * sign-in, so its guard hands each live read here (DRY_RUN_BROKER) and this
 * runs the guard again with the real state directory; that guard classifies
 * the argv itself, so only a read ever runs with the sign-in, whoever calls
 * the broker. It runs in brokerCwd, with RUN_DIR pointed at the harness
 * directory and none of the fake's or the record's settings, and answers in
 * its reply: the exit code, the length of stderr, stderr, stdout. The broker
 * lives as long as this process: an agent that outlives its harness reaches
 * nothing live at all.
 */
export function startBroker(): string {
  const { env, realEnvHome, harnessDir, guardDir } = ctx();
  // The shell's PATH, not the agent's: the agent's leads with the baked guard, which would send the broker's read back to the broker.
  const brokerEnv: Record<string, string> = { ...env, PATH: process.env.PATH ?? "", HOME: realEnvHome, RUN_DIR: harnessDir, DRY_RUN_LIVE_READ: "1", DRY_RUN_BROKER: "", DRY_RUN_REAL_CODECAST_DIR: process.env.CODECAST_DIR ?? "" };
  // The real CLI reads its config where the shell keeps it, not in the agent's home.
  for (const k of ["DRY_RUN_FAKE", "DRY_RUN_FAKE_SEED", "DRY_RUN_FAKE_VIA_BROKER", "DRY_RUN_SERVE_DIR", "DRY_RUN_TAG", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete brokerEnv[k];
  for (const k of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) if (process.env[k]) brokerEnv[k] = process.env[k]!;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = Buffer.from(await req.arrayBuffer());
      const route = new URL(req.url).pathname;
      if (route === "/fake") return await answerFake(body, Number(req.headers.get("x-dry-run-stdin-bytes") ?? 0), req.headers.get("x-dry-run-call"));
      const callId = req.headers.get("x-dry-run-call");
      if (route === "/begin") return recordBegin(body);
      if (route === "/mark") return recordMark(body);
      if (route === "/help") {
        const words = body.toString("utf8").split("\0").filter(Boolean);
        markCall(callId, [...words, "--help"], "HELP");
        return cliHelp(words);
      }
      if (route === "/tree") return cliNoSignIn(["agent-context", "--json"]);
      const argv = body.toString("utf8").split("\0");
      if (argv[argv.length - 1] === "") argv.pop();
      const p = Bun.spawn(["bash", path.join(guardDir, "cast"), ...argv], { env: brokerEnv, cwd: brokerCwd(), stdin: "ignore", stdout: "ignore", stderr: "pipe" });
      const said = await new Response(p.stderr).text();
      await p.exited;
      // The broker's guard reads only what it takes for a read; what it refused (the agent posting a write here) is that.
      const log = path.join(harnessDir, "calls.log");
      const logged = loggedArgv(argv);
      const refusedHere = fs.existsSync(log) && fs.readFileSync(log, "utf8").split("\n").some((line) => line === `REFUSED ${logged}`);
      fs.rmSync(log, { force: true });
      markCall(callId, argv, refusedHere ? "REFUSED" : "LIVE");
      const copy = path.join(harnessDir, "live-reads", readKey(argv));
      const code = fs.existsSync(`${copy}.exit`) ? fs.readFileSync(`${copy}.exit`, "utf8").trim() || "1" : "1";
      const out = fs.existsSync(`${copy}.out`) ? fs.readFileSync(`${copy}.out`) : Buffer.alloc(0);
      const err = Buffer.from(said);
      return new Response(Buffer.concat([Buffer.from(`${code}\n${err.length}\n`), err, out]));
    },
  });
  return `http://127.0.0.1:${server.port}/read`;
}
