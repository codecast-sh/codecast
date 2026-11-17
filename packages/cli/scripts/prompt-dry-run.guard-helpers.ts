// Shared by the prompt dry run's guard tests (prompt-dry-run*.guard.test.ts):
// a guard world with a fake real `cast` (world), and a harness world with a
// fake `claude` that records how it was called (harnessWorld).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const GUARD = path.join(import.meta.dir, "prompt-dry-run-bin", "cast");
export const HARNESS = path.join(import.meta.dir, "prompt-dry-run.ts");
// One root for every test file in the process (bun runs them in one), removed when the process exits.
export const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dry-run-guard-"));
process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

export function write(file: string, text: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

/** A stand-in for `cast agent-context --json`: each entry is a path, whether it
 *  runs something bare, and its aliases. Subcommands are derived from the paths. */
export type TreeEntry = [path: string, runsBare: boolean | undefined, aliases?: string[]];
export function agentContext(entries: TreeEntry[]) {
  const commands = entries.map(([command, runsBare, aliases]) => ({
    command,
    path: command.split(" "),
    aliases: aliases ?? [],
    subcommands: entries.map(([c]) => c).filter((c) => c.startsWith(`${command} `) && c.split(" ").length === command.split(" ").length + 1),
    ...(runsBare === undefined ? {} : { runsBare }),
  }));
  return JSON.stringify({ schemaVersion: 1, version: "9.9.9", commandCount: commands.length, commands });
}

/** A tree shaped like the CLI's: pure groups, groups that run something bare
 *  (sync's own action, hosts's default ls), leaves, and an alias. */
export const TREE: TreeEntry[] = [
  ["org", false], ["org ls", true], ["org review", true], ["org propose", true],
  ["task", false], ["task ls", true], ["task create", true],
  ["workspace", false, ["ws"]], ["workspace ls", true],
  ["pr", false], ["pr comment", true], ["pr merge", true], ["pr review", true],
  ["chat", false], ["chat send", true], ["chat mark-read", true],
  ["sync", true], ["sync status", true],
  ["hosts", true], ["hosts ls", true],
  ["send", true], ["decide", true], ["state", true],
  ["brief", true], ["brief edit", true], ["call", true],
];

/** A run dir, a serve dir and a fake real `cast` that answers `LIVE <argv>`,
 *  answers `agent-context --json` from `tree`, and records every argv it gets. */
export function world(serve: { files?: Record<string, string>; frozen?: string[]; tree?: TreeEntry[] } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "w-"));
  const runDir = path.join(dir, "run");
  const serveDir = path.join(dir, "serve");
  const fakeBin = path.join(dir, "bin");
  const realCalls = path.join(dir, "real-calls");
  const tree = path.join(dir, "agent-context.json");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(serveDir, { recursive: true });
  write(tree, agentContext(serve.tree ?? TREE));
  write(path.join(fakeBin, "cast"), [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> "${realCalls}"`,
    `[ "$*" = "agent-context --json" ] && { cat "${tree}"; exit 0; }`,
    'echo "LIVE $* dir=${CODECAST_DIR:-}"',
    "",
  ].join("\n"), 0o755);
  for (const [name, text] of Object.entries(serve.files ?? {})) write(path.join(serveDir, name), text);
  if (serve.frozen) write(path.join(serveDir, "frozen"), serve.frozen.join("\n") + "\n");
  const cast = (...argv: string[]) => {
    const r = Bun.spawnSync(["bash", GUARD, ...argv], {
      env: { PATH: `${fakeBin}:/usr/bin:/bin`, RUN_DIR: runDir, DRY_RUN_SERVE_DIR: serveDir, DRY_RUN_REAL_CODECAST_DIR: "/real/state", CODECAST_DIR: path.join(runDir, ".nocast") },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const log = () => fs.readFileSync(path.join(runDir, "calls.log"), "utf8");
  /** Every argv the real CLI was run with. */
  const real = () => (fs.existsSync(realCalls) ? fs.readFileSync(realCalls, "utf8").split("\n").filter(Boolean) : []);
  return { cast, log, real, runDir, serveDir, helpDir: path.join(runDir, ".cast-help") };
}

/** An argv as calls.log keeps it: an argument that is not a plain word single-quoted. */
export const logged = (argv: string[]) => argv.map((a) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");

export function harnessWorld(stream: object[]) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "h-"));
  const bin = path.join(dir, "bin");
  // Recordings and the scripted stream sit inside the run dir: a run's sandbox reads and writes nothing else under its home folder.
  const rec = path.join(dir, "run", ".rec");
  const state = path.join(dir, "state");
  fs.mkdirSync(rec, { recursive: true });
  write(path.join(bin, "claude"), [
    "#!/usr/bin/env bash",
    'printf "%s\\n" "$@" > "$FAKE_CLAUDE_REC/argv"',
    'cat > "$FAKE_CLAUDE_REC/stdin"',
    'printf "%s\\n" "${CLAUDE_CODE_MAX_OUTPUT_TOKENS:-unset}" "${CLAUDE_CODE_DISABLE_THINKING:-unset}" "${CLAUDE_CODE_OAUTH_TOKEN:-unset}" > "$FAKE_CLAUDE_REC/env"',
    // What a Bash command sees first on PATH after the user's profile shadowed it, once CLAUDE_ENV_FILE is sourced.
    '( PATH="/profile/bin:$PATH"; . "$CLAUDE_ENV_FILE"; printf "%s" "${PATH%%:*}" ) > "$FAKE_CLAUDE_REC/path-first"',
    // A command the agent runs, when the test gives one, with what it printed.
    '[ -z "${FAKE_CLAUDE_BASH:-}" ] || eval "$FAKE_CLAUDE_BASH" > "$FAKE_CLAUDE_REC/bash" 2>&1',
    'cat "$FAKE_CLAUDE_STREAM"',
    "",
  ].join("\n"), 0o755);
  // The real CLI the guard finds: answers anything, and records each argv with the state dir it ran under.
  write(path.join(bin, "cast"), [
    "#!/usr/bin/env bash",
    'printf "%s dir=%s\\n" "$*" "${CODECAST_DIR:-}" >> "$FAKE_CLAUDE_REC/real-calls"',
    'echo "LIVE $* dir=${CODECAST_DIR:-}"',
    "",
  ].join("\n"), 0o755);
  write(path.join(rec, "stream.jsonl"), stream.map((e) => JSON.stringify(e)).join("\n") + "\n");
  // `--account fake` reads its token from the state dir, so no keychain is touched.
  write(path.join(state, "cc-token-fake.env"), "CLAUDE_CODE_OAUTH_TOKEN='fake-token'\n");
  write(path.join(dir, "prompt.md"), "Reply with the word ok.");
  write(path.join(dir, "system.md"), "Answer briefly.");
  const run = (...args: string[]) => runWith({}, ...args);
  const envWith = (extra: Record<string, string>) => ({ PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, CODECAST_DIR: state, FAKE_CLAUDE_REC: rec, FAKE_CLAUDE_STREAM: path.join(rec, "stream.jsonl"), DRY_RUN_PASS_ENV: "FAKE_CLAUDE_REC,FAKE_CLAUDE_STREAM,FAKE_CLAUDE_BASH", ...extra });
  const runWith = (extra: Record<string, string>, ...args: string[]) => {
    const r = Bun.spawnSync(["bun", HARNESS, ...args], { env: envWith(extra) });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  /** The same run, in flight alongside others. */
  const runAsync = async (extra: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawn(["bun", HARNESS, ...args], { env: envWith(extra), stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    return { code, err };
  };
  const recorded = (name: string) => (fs.existsSync(path.join(rec, name)) ? fs.readFileSync(path.join(rec, name), "utf8") : null);
  return { dir, bin, rec, state, run, runWith, runAsync, recorded, runDir: path.join(dir, "run"), prompt: path.join(dir, "prompt.md"), system: path.join(dir, "system.md") };
}

export const reply = (text: string, stop: string, outputTokens: number) => [
  { type: "stream_event", event: { type: "message_start", message: { model: "m-pinned", usage: { input_tokens: 190, output_tokens: 1 } } } },
  { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
  { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: outputTokens } } },
  { type: "assistant", message: { content: [{ type: "text", text }] } },
];

/** A python3 the sandbox tests can run, when the machine has one outside the home folder. */
export const PYTHON = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"].find((p) => fs.existsSync(p));
/** A postgres install for the end-to-end replay, when the machine has one. */
export const PG = ["/opt/homebrew/opt/postgresql@17/bin", "/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@15/bin", "/opt/homebrew/bin", "/usr/local/bin"].find((d) => fs.existsSync(path.join(d, "initdb")) && fs.existsSync(path.join(d, "psql")) && Bun.spawnSync([path.join(d, "postgres"), "-V"]).exitCode === 0);
