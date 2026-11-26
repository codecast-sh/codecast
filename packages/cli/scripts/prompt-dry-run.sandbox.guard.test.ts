// The prompt dry run harness, run as a subprocess with a fake `claude` and a
// fake real `cast` (prompt-dry-run.guard-helpers.ts): the closed world an
// agent run gets: no real file, home, network, process environment or temp dir
// reachable, nothing left running, and --exec.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HARNESS, harnessWorld, logged, PYTHON, tmpRoot, world, write } from "./prompt-dry-run.guard-helpers.ts";

// Every test spawns bash and a fake CLI; on a loaded machine one spawn can take a second.
setDefaultTimeout(30_000);

describe("prompt-dry-run.ts: the closed world", () => {
  test.if(process.platform === "darwin")("--read-only refuses file writes in the checkout and every connection but the model's and the broker's", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    // Outside the per-user temp root, which the sandbox leaves writable for Claude Code's own caches.
    const checkout = path.join(import.meta.dir, `.ro-checkout-${process.pid}`);
    fs.mkdirSync(checkout, { recursive: true });
    const bash = [
      `( : > '${checkout}/probe.txt' ) 2>&1 | sed 's/^/write: /'`,
      `/usr/bin/nc -z -G 3 1.1.1.1 443 2>&1 && echo "direct: connected" || echo "direct: refused"`,
      `echo "proxy: \${HTTPS_PROXY:-none}"`,
      `curl -sS -o /dev/null --max-time 10 https://github.com 2>&1 | sed 's/^/github: /'`,
      "cast task ls 2>&1 | sed 's/^/read: /'",
    ].join("; ");
    try {
      const r = h.runWith({ FAKE_CLAUDE_BASH: bash }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--cwd", checkout, "--read-only");
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const said = h.recorded("bash")!;
      expect(said).toMatch(/write: .*Operation not permitted/);
      expect(fs.existsSync(path.join(checkout, "probe.txt"))).toBe(false);
      expect(said).toContain("direct: refused");
      expect(said).toMatch(/proxy: http:\/\/127\.0\.0\.1:\d+/);
      expect(said).toMatch(/github: .*403/);
      expect(said).toContain(`read: LIVE task ls dir=${h.state}`);
    } finally {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  }, 90_000);

  // Each escape a guidance replay took on 2026-11-16 (ct-95483), tried by one rep: it listed a checkout's
  // secrets through its secret skill, fetched an OAuth client, wrote a catcher under the real ~/.cache and
  // left it listening on 127.0.0.1:8794 after the rep. Every one must fail, and nothing may outlive the rep.
  // A Python outside the system's own, whose environment ps can read (it hides that of /usr/bin binaries).

  test.if(process.platform === "darwin" && !!PYTHON)("a replayed agent reads, writes and reaches nothing real, and leaves nothing running", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    // The real machine as the agent would find it: another repo with a .env and a secret skill under the home folder.
    const other = path.join(h.dir, "src", "acme-mobile", "server");
    write(path.join(other, ".env"), "GOOGLE_ADS_CLIENT_SECRET=real\n");
    write(path.join(other, ".claude", "skills", "secret", "scripts", "secret"), "#!/bin/sh\necho GOOGLE_ADS_CLIENT_SECRET\n", 0o755);
    // The tree the agent is given to read holds the same two, which stay unreadable even there.
    const checkout = path.join(import.meta.dir, `.closed-checkout-${process.pid}`);
    write(path.join(checkout, "README.md"), "readable\n");
    write(path.join(checkout, ".env.local"), "TOKEN=real\n");
    write(path.join(checkout, ".claude", "skills", "secret", "SKILL.md"), "secret\n");
    // Review finding 6 (2026-11-16): secret shapes beyond .env.
    for (const f of [".envrc", ".dev.vars", "deploy.pem", "id_ed25519", "service-account-prod.json", ".npmrc", ".netrc"]) write(path.join(checkout, f), "secret\n");
    const t = (name: string, cmd: string) => `( ${cmd} ) >/dev/null 2>&1; echo "${name} $?"`;
    // Review finding (2026-11-17): a process the sandbox did not start, which no signal from inside may reach.
    const outside = Bun.spawn(["/bin/sleep", "120"], { stdout: "ignore", stderr: "ignore" });
    const bash = [
      // Processes that leave the agent's process group (double fork + setsid), as nohup or a tmux server would:
      // one a non-system binary (its tag shows; the 2026-11-16 catcher was Homebrew python), one a system binary standing in the run dir (its cwd shows).
      `/usr/bin/perl -e 'use POSIX; fork and exit; POSIX::setsid(); fork and exit; open(my $f, ">", "$ENV{FAKE_CLAUDE_REC}/lingerer"); print $f $$; close $f; exec "${PYTHON}", "-c", "import time; time.sleep(300)"'`,
      `( cd "$FAKE_CLAUDE_REC" && /usr/bin/perl -e 'use POSIX; fork and exit; POSIX::setsid(); fork and exit; open(my $f, ">", "$ENV{FAKE_CLAUDE_REC}/lingerer2"); print $f $$; close $f; exec "/bin/sleep", "300"' )`,
      t("list-home", `ls '${h.dir}'`),
      t("read-other-repo", `cat '${other}/.env'`),
      t("run-other-secret-skill", `'${other}/.claude/skills/secret/scripts/secret' list`),
      t("read-checkout", "cat README.md"),
      t("read-checkout-env", "cat .env.local"),
      t("read-checkout-secret-skill", "cat .claude/skills/secret/SKILL.md"),
      ...[".envrc", ".dev.vars", "deploy.pem", "id_ed25519", "service-account-prod.json", ".npmrc", ".netrc"].map((f) => t(`read-checkout-${f}`, `cat ${f}`)),
      t("write-user-cache", `: > "$(getconf DARWIN_USER_CACHE_DIR)dry-run-probe-$$"`),
      t("write-real-cache", `mkdir -p '${h.dir}/.cache/gadsoauth' && : > '${h.dir}/.cache/gadsoauth/catcher.py'`),
      t("write-checkout", ": > probe.txt"),
      t("curl-via-proxy", "curl -sSf --max-time 10 https://oauth2.googleapis.com/token"),
      t("curl-direct", "curl -sSf --noproxy '*' --max-time 5 https://1.1.1.1"),
      t("listen-8794", `/usr/bin/perl -MIO::Socket::INET -e 'exit(IO::Socket::INET->new(Listen => 1, LocalAddr => "127.0.0.1", LocalPort => 8794, ReuseAddr => 1) ? 0 : 1)'`),
      t("cast-vault", "cast vault get GOOGLE_ADS_CLIENT_SECRET"),
      t("env-credential", '[ -n "${FOO_API_TOKEN:-}" ]'),
      "sleep 1",
      // A process outside the sandbox: a signal to it must be refused (`kill -9 -1` would otherwise end every process the user owns).
      t("signal-outside", `kill -0 ${outside.pid}`),
      t("kill-outside", `kill -TERM ${outside.pid}`),
    ].join("; ");
    try {
      const r = h.runWith({ FAKE_CLAUDE_BASH: bash, FOO_API_TOKEN: "s3cret" }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--cwd", checkout);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      const results = Object.fromEntries(h.recorded("bash")!.trim().split("\n").map((l) => l.split(" ")));
      // The one thing it may do: read the tree it was given.
      expect(results["read-checkout"]).toBe("0");
      for (const escape of ["list-home", "read-other-repo", "run-other-secret-skill", "read-checkout-env", "read-checkout-secret-skill", "write-real-cache", "write-checkout", "curl-via-proxy", "curl-direct", "listen-8794", "cast-vault", "env-credential", "write-user-cache", ...[".envrc", ".dev.vars", "deploy.pem", "id_ed25519", "service-account-prod.json", ".npmrc", ".netrc"].map((f) => `read-checkout-${f}`)]) {
        expect({ escape, rc: results[escape] }).not.toEqual({ escape, rc: "0" });
      }
      expect(fs.existsSync(path.join(h.dir, ".cache", "gadsoauth"))).toBe(false);
      expect(fs.existsSync(path.join(checkout, "probe.txt"))).toBe(false);
      expect(h.recorded("real-calls") ?? "").not.toContain("vault");
      expect(fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8")).toContain("REFUSED vault get GOOGLE_ADS_CLIENT_SECRET");
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      expect(results["signal-outside"]).not.toBe("0");
      expect(results["kill-outside"]).not.toBe("0");
      expect(alive(outside.pid!)).toBe(true);
      // The detached lingerers were still running when the turn ended (the sweep killed them) and are dead now.
      for (const name of ["lingerer", "lingerer2"]) {
        const pid = Number(h.recorded(name));
        expect({ name, pid: pid > 0 }).toEqual({ name, pid: true });
        expect({ name, alive: alive(pid) }).toEqual({ name, alive: false });
      }
      expect(Number(fs.readFileSync(path.join(h.runDir, "swept.txt"), "utf8"))).toBeGreaterThanOrEqual(2);
    } finally {
      outside.kill("SIGKILL");
      fs.rmSync(checkout, { recursive: true, force: true });
    }
  }, 90_000);

  // Review finding 1 (2026-11-16): the broker ran the guard outside the sandbox, with the real home folder, in a
  // directory the agent chose (or its run dir), so a bunfig.toml preload there ran the agent's code unsandboxed;
  // and it wrote each live read's copy into the run dir, through any link the agent had planted there.

  test.if(process.platform === "darwin")("an agent cannot read another process's environment, the harness's included", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const probe = path.join(h.rec, "procargs.js");
    write(probe, [
      'const { dlopen, FFIType, ptr } = require("bun:ffi");',
      'const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", { sysctl: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i32 } });',
      "const mib = new Int32Array([1, 49, Number(process.argv[2])]); const buf = new Uint8Array(1 << 16); const size = new BigUint64Array([BigInt(buf.length)]);",
      'const rc = symbols.sysctl(ptr(mib), 3, ptr(buf), ptr(size), null, 0);',
      'console.log(rc === 0 && Buffer.from(buf.slice(0, Number(size[0]))).toString("latin1").includes("PROC-ENV-SENTINEL") ? "read" : "refused");',
    ].join("\n"));
    const bash = [
      `echo "parent: $('${process.execPath}' '${probe}' $PPID)"`,
      // The model is reached through the harness, which alone holds the login: anything but the model's endpoints is refused.
      `echo "account: $(curl -s -o /dev/null -w '%{http_code}' "$ANTHROPIC_BASE_URL/api/oauth/profile")"`,
    ].join("; ");
    expect(h.runWith({ FAKE_CLAUDE_BASH: bash, PROBE_TOKEN: "PROC-ENV-SENTINEL" }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake").code).toBe(0);
    expect(h.recorded("bash")).toContain("parent: refused");
    expect(h.recorded("bash")).toContain("account: 403");
    // Claude Code in the sandbox holds a placeholder: the login (here "fake-token") never enters any process the agent can read.
    expect(h.recorded("env")!.split("\n")[2]).toBe("sk-ant-oat01-dry-run-placeholder");
  }, 60_000);

  // Review findings 3, 5 and 7 (2026-11-16): the fake's world raced under parallel calls, a failed write was logged
  // (and judged) as done, and calls.log and the world sat where the agent could forge them.

  test.if(process.platform === "darwin")("a run reads no data home, keeps no shell variable, and leaves a calls.log the agent could not shape", () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0.01 }]);
    const localBin = path.join(h.dir, ".local", "bin");
    write(path.join(localBin, "python3"), "#!/bin/sh\necho py\n", 0o755);
    write(path.join(h.dir, ".local", "share", "amp", "secrets.json"), '{"token":"AMP-SENTINEL"}');
    write(path.join(h.dir, ".local", "share", "codecast", "evals", "labels", "l.json"), '{"label":"LABEL-SENTINEL"}');
    write(path.join(h.dir, ".local", "state", "gh", "state.yml"), "GH-SENTINEL\n");
    const fake = path.join(h.dir, "fake", "fake.ts");
    write(fake, "export function openFake() { return (argv: string[]) => argv[0] === 'task' && argv[1] === 'create' ? { out: 'ok Created ct-1\\n', exit: 0 } : null; }\n");
    write(path.join(h.bin, "cast"), ["#!/usr/bin/env bash", 'if [ "$1" = agent-context ]; then echo \'{"commands":[]}\'; exit 0; fi', 'echo "LIVE $*"', ""].join("\n"), 0o755);
    const t = (name: string, cmd: string) => `( ${cmd} ) >/dev/null 2>&1; echo "${name} $?"`;
    const tools = JSON.stringify({ model: "m", max_tokens: 1, messages: [], tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] });
    const mcp = JSON.stringify({ model: "m", max_tokens: 1, messages: [], mcp_servers: [{ type: "url", url: "https://example.com/sse", name: "x" }] });
    const bash = [
      t("read-amp", `cat '${h.dir}/.local/share/amp/secrets.json'`),
      t("read-labels", `cat '${h.dir}/.local/share/codecast/evals/labels/l.json'`),
      t("read-gh-state", `cat '${h.dir}/.local/state/gh/state.yml'`),
      t("list-local", `ls '${h.dir}/.local'`),
      t("env-db-url", '[ -n "${MY_DB_URL:-}" ]'),
      // A line break in an argument, carrying a line of its own.
      "cast task create $'x\\nFAKED role wake @ceo all done' > /dev/null 2>&1",
      "printf 'task\\0create\\0y\\nREFUSED role wake @ceo\\0' | curl -s --data-binary @- \"$DRY_RUN_BROKER\" > /dev/null 2>&1",
      // The guard's marks, edited in the file the agent can write.
      "cast trigger add z > /dev/null 2>&1",
      "sed -i '' '/^REFUSED trigger add/d' \"$RUN_DIR/calls.log\"; echo 'SERVED forged read' >> \"$RUN_DIR/calls.log\"",
      `echo "server-tools: $(curl -s -X POST -H 'content-type: application/json' --data '${tools}' "$ANTHROPIC_BASE_URL/v1/messages")"`,
      `echo "mcp: $(curl -s -X POST -H 'content-type: application/json' --data '${mcp}' "$ANTHROPIC_BASE_URL/v1/messages")"`,
    ].join("; ");
    const r = h.runWith({ FAKE_CLAUDE_BASH: bash, MY_DB_URL: "postgres://u:DB-SENTINEL@h/d", XDG_CONFIG_HOME: path.join(h.dir, "xdg-config"), PATH: `${localBin}:${h.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake", "--fake", fake);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const said = h.recorded("bash")!;
    for (const name of ["read-amp", "read-labels", "read-gh-state", "list-local", "env-db-url"]) expect({ name, ok: said.includes(`${name} 0`) }).toEqual({ name, ok: false });
    expect(said).toMatch(/server-tools: dry run: server tools are not available here \(web_fetch_20250910\)/);
    expect(said).toMatch(/mcp: dry run: mcp_servers would reach other hosts/);
    const log = fs.readFileSync(path.join(h.runDir, "calls.log"), "utf8");
    expect(log).not.toMatch(/^FAKED role wake/m);
    expect(log).not.toMatch(/^REFUSED role wake/m);
    expect(log).toContain("FAKED task create 'x\\nFAKED role wake @ceo all done'");
    expect(log).toContain("REFUSED trigger add z");
    expect(log).not.toContain("SERVED forged read");
  }, 60_000);

  test.if(process.platform === "darwin")("the agent dies with its harness, even when the harness is killed outright", async () => {
    const h = harnessWorld([{ type: "result", result: "Done.", is_error: false }]);
    const p = Bun.spawn(["bun", HARNESS, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake"], {
      env: { PATH: `${h.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: h.dir, CODECAST_DIR: h.state, FAKE_CLAUDE_REC: h.rec, FAKE_CLAUDE_STREAM: path.join(h.rec, "stream.jsonl"), DRY_RUN_PASS_ENV: "FAKE_CLAUDE_REC,FAKE_CLAUDE_STREAM,FAKE_CLAUDE_BASH", FAKE_CLAUDE_BASH: `echo $$ > "$FAKE_CLAUDE_REC/agent-pid"; sleep 120` },
      stdout: "ignore", stderr: "ignore",
    });
    const until = async (ok: () => boolean, ms: number) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await Bun.sleep(200); return ok(); };
    expect(await until(() => !!h.recorded("agent-pid")?.trim(), 30_000)).toBe(true);
    const agent = Number(h.recorded("agent-pid")!.trim());
    const alive = () => { try { process.kill(agent, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    p.kill("SIGKILL");
    expect(await until(() => !alive(), 20_000)).toBe(true);
  }, 60_000);

  // ct-56832: two agents in flight both wrote /tmp/org_inputs.json and one graded the other's world.

  test.if(process.platform === "darwin")("two agent runs in flight cannot see each other's /tmp scratch, and each keeps its own under $TMPDIR", async () => {
    const shared = `/tmp/dry-run-isolation-${process.pid}.json`;
    fs.writeFileSync(shared, "planted outside");
    try {
      const agent = (id: string) => [
        `echo ${id} > ${shared} && echo tmp-write-ok || echo tmp-write-refused`,
        `cat ${shared} 2>&1 | sed 's/^/tmp-read: /'`,
        `echo ${id} > "$TMPDIR/x.json"`,
        "sleep 1",
        `echo "mine: $(cat "$TMPDIR/x.json")"`,
        `echo "claude-tmp: $CLAUDE_CODE_TMPDIR"`,
      ].join("; ");
      const result = [{ type: "result", result: "Done.", is_error: false, num_turns: 1, total_cost_usd: 0 }];
      const [a, b] = [harnessWorld(result), harnessWorld(result)];
      const runs = await Promise.all([a, b].map((h, i) => h.runAsync({ FAKE_CLAUDE_BASH: agent(`agent-${i}`) }, "--run", h.runDir, "--prompt", h.prompt, "--model", "m", "--account", "fake")));
      expect(runs.map((r) => r.code)).toEqual([0, 0]);
      for (const [i, h] of [a, b].entries()) {
        const said = h.recorded("bash")!;
        expect(said).toContain("tmp-write-refused");
        expect(said).toContain("Operation not permitted");
        expect(said).not.toContain("planted outside");
        expect(said).toContain(`mine: agent-${i}`);
        expect(said).not.toContain(`agent-${1 - i}`);
        expect(said).toContain(`claude-tmp: ${path.join(h.runDir, "tmp")}`);
        expect(JSON.parse(fs.readFileSync(path.join(h.runDir, "args.json"), "utf8")).isolation).toBe("sandbox-exec");
      }
      expect(fs.readFileSync(shared, "utf8")).toBe("planted outside");
    } finally {
      fs.rmSync(shared, { force: true });
    }
  }, 60_000);

  test.skipIf(process.platform !== "darwin")("--exec runs one command in the closed world: no network, no home, no env, writes only in its run dir, its exit code passed back", () => {
    const run = path.join(tmpRoot, "exec-run");
    const outside = fs.mkdtempSync(path.join(tmpRoot, "exec-outside-"));
    const home = fs.realpathSync(os.homedir());
    const probe = [
      `: > "${run}/inside" && echo run-write`,
      `( : > "${outside}/x" ) 2>/dev/null && echo outside-write`,
      `ls "${home}" >/dev/null 2>&1 && echo home-read`,
      `/usr/bin/nc -z -G 3 1.1.1.1 443 >/dev/null 2>&1 && echo network`,
      `[ -n "$EXEC_SECRET" ] && echo env`,
      "exit 7",
    ].join("; ");
    const r = Bun.spawnSync(["bun", HARNESS, "--exec", "--run", run, "--", "/bin/sh", "-c", probe], { env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: os.homedir(), EXEC_SECRET: "s3cret" } });
    expect({ code: r.exitCode, out: fs.readFileSync(path.join(run, "exec.out"), "utf8"), exit: fs.readFileSync(path.join(run, "exit.txt"), "utf8") }).toEqual({ code: 7, out: "run-write\n", exit: "7\n" });
    expect(fs.readdirSync(outside)).toEqual([]);
  }, 60_000);

  // A child that detaches (nohup, its own session, a pipe held open) is killed when --exec ends, and --timeout ends it however it hangs.

  test.skipIf(process.platform !== "darwin")("--exec leaves nothing running: a detached child dies with it, and --timeout ends a hung command", () => {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: os.homedir() };
    const left = path.join(tmpRoot, "exec-left");
    const r = Bun.spawnSync(["bun", HARNESS, "--exec", "--run", left, "--", "/bin/sh", "-c", 'nohup /bin/sleep 300 & echo $! > child.pid; /usr/bin/perl -e "use POSIX; POSIX::setsid(); exec q{/bin/sleep}, 301" & echo $! > setsid.pid; exit 0'], { env, timeout: 30_000 });
    expect(r.exitCode).toBe(0);
    for (const f of ["child.pid", "setsid.pid"]) expect(alive(Number(fs.readFileSync(path.join(left, f), "utf8")))).toBe(false);
    const hung = path.join(tmpRoot, "exec-hung");
    const started = Date.now();
    const h = Bun.spawnSync(["bun", HARNESS, "--exec", "--run", hung, "--timeout", "2", "--", "/bin/sh", "-c", "echo $$ > sh.pid; /bin/sleep 300 | /bin/cat"], { env, timeout: 30_000 });
    expect({ code: h.exitCode, exit: fs.readFileSync(path.join(hung, "exit.txt"), "utf8") }).toEqual({ code: 124, exit: "124\n" });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(alive(Number(fs.readFileSync(path.join(hung, "sh.pid"), "utf8")))).toBe(false);
  }, 60_000);
});
