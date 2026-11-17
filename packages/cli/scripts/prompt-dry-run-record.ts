// The harness's record of the agent's `cast` calls, which calls.log is rebuilt
// from once the agent is gone: each call's argv and the one mark it earned,
// checked against the guard's own classification and the served record.
import * as fs from "node:fs";
import * as path from "node:path";
import { ctx } from "./prompt-dry-run-context.ts";

/** The calls the fake answered, each with its turn, as calls.log lines: the harness's record, merged into calls.log once the agent is gone. */
const answered: Array<{ turn: number; line: string }> = [];
let turnNo = 1;

/** Calls from here on are the turn's: the guard's preflight before it is not recorded. */
export function startRecording(): void {
  recording = true;
}

/** The turn the calls that follow belong to. */
export function setTurn(n: number): void {
  turnNo = n;
}

/** An argv as the guard logs it (prompt-dry-run-bin/cast logged_argv): a word that is not plain is single-quoted. */
export function loggedArgv(argv: string[]): string {
  // A line break is written as \\n (\\r): an argument can never start a line of its own in calls.log.
  return argv.map((raw) => {
    const a = raw.replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    return /^[A-Za-z0-9_./:=@%+,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`;
  }).join(" ");
}

/**
 * The record of what the agent's `cast` calls did, which calls.log is
 * rebuilt from. A call opens with /begin (the guard posts its argv and gets
 * an id), and gets exactly one mark: this process writes the marks it
 * produces itself (LIVE, HELP, FAKED, FAKEERR, CLI), and accepts one the
 * guard posts (SERVED, UNSERVED, REFUSED, UNKNOWN) only when it is true of
 * that argv (verifyMark). The agent can post here too, so it can add a call,
 * which is the same as making it, but never a mark its argv does not earn,
 * and nothing before its first turn (the guard's preflight) is recorded.
 */
const calls = new Map<string, { argv: string[]; marked: boolean }>();
let recording = false;
let callSeq = 0;

function beginCall(argv: string[]): string {
  const id = `c${++callSeq}-${crypto.randomUUID().slice(0, 8)}`;
  calls.set(id, { argv, marked: false });
  if (recording) answered.push({ turn: turnNo, line: loggedArgv(argv) });
  return id;
}

/** One mark for a call: by id when the guard named one, else a call of its own (the agent posted to the broker directly). */
export function markCall(id: string | null, argv: string[], mark: string): void {
  const call = id ? calls.get(id) : undefined;
  if (call?.marked) return;
  if (call) call.marked = true;
  else beginCall(argv);
  if (recording) answered.push({ turn: turnNo, line: `${mark} ${loggedArgv(call?.argv ?? argv)}` });
}

const POSTED_MARKS = ["SERVED", "UNSERVED", "REFUSED", "UNKNOWN"];

/** What the guard (with DRY_RUN_CLASSIFY) takes an argv for: read or write. */
export async function classify(argv: string[]): Promise<string> {
  const { guardDir, brokerCwdDefault } = ctx();
  const p = Bun.spawn(["bash", path.join(guardDir, "cast"), ...argv], { env: { PATH: process.env.PATH ?? "", DRY_RUN_CLASSIFY: "1" }, cwd: brokerCwdDefault, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return (await new Response(p.stdout).text()).trim();
}

/** Whether the served record answers an argv, as the guard serves it (prompt-dry-run-bin/cast): its key, a prefix marker, the org files, or the proposals listing. */
function served(argv: string[]): boolean {
  const { serveDir } = ctx();
  if (!serveDir) return false;
  const two = `${argv[0] ?? ""} ${argv[1] ?? ""}`;
  if (/^org (inputs|health|ls|list)/.test(two) && ["org-inputs.json", "org-health.json", "org-ls.json"].some((f) => fs.existsSync(path.join(serveDir, f)))) return true;
  if (two === "org proposals" && !argv.some((a) => a.startsWith("--withdraw"))) return true;
  const reads = path.join(serveDir, "reads");
  if (fs.existsSync(path.join(reads, `${readKey(argv)}.out`))) return true;
  const joined = argv.map((a) => `${a}\x1f`).join("");
  return fs.existsSync(reads) && fs.readdirSync(reads).some((f) => f.endsWith(".prefix") && (() => { const pre = fs.readFileSync(path.join(reads, f), "utf8"); return pre.length < joined.length && joined.startsWith(pre); })());
}

/** Whether the served dir freezes an argv's verb (prompt-dry-run-bin/cast frozen). */
function frozen(argv: string[]): boolean {
  const { serveDir } = ctx();
  const f = serveDir ? path.join(serveDir, "frozen") : "";
  if (!f || !fs.existsSync(f)) return false;
  const lines = fs.readFileSync(f, "utf8").split("\n");
  return lines.includes("*") || lines.includes(argv[0] ?? "") || lines.includes(`${argv[0] ?? ""} ${argv[1] ?? ""}`);
}

/** Whether a mark the guard posted is true of its argv. */
async function verifyMark(argv: string[], mark: string): Promise<boolean> {
  if (mark === "UNKNOWN") return true;
  if (mark === "SERVED") return served(argv);
  const kind = await classify(argv);
  if (mark === "REFUSED") return kind === "write";
  if (mark === "UNSERVED") return kind === "read" && frozen(argv) && !served(argv);
  return false;
}

/** /begin: a call's argv, \0 separated; answers its id. */
export function recordBegin(body: Buffer): Response {
  const argv = body.toString("utf8").split("\0");
  if (argv[argv.length - 1] === "") argv.pop();
  return new Response(`${beginCall(argv)}\n`);
}

/** /mark: `<id>\0<MARK>`, a mark the guard reached for the call it opened. */
export async function recordMark(body: Buffer): Promise<Response> {
  const [id = "", mark = ""] = body.toString("utf8").split("\0");
  const call = calls.get(id);
  if (!call || call.marked || !POSTED_MARKS.includes(mark) || !(await verifyMark(call.argv, mark))) return new Response("refused\n", { status: 400 });
  markCall(id, call.argv, mark);
  return new Response("ok\n");
}

/** The served-read key of an argv (packages/evals/src/served.ts servedReadKey). */
export const readKey = (argv: string[]) => new Bun.CryptoHasher("sha256").update(argv.map((a) => `${a}\x1f`).join("")).digest("hex");

/**
 * Every `cast` call the agent's Bash commands name, from the turn's stream
 * (kept where the agent cannot edit it), set against the record. The guard
 * the agent runs records every call it gets whatever the agent's environment
 * says (bakeGuard), so a name the record lacks never reached the guard: the
 * shell never ran it (`a && cast send x` after `a` failed), or the agent went
 * around the guard, where nothing it does reaches anything. Each joins the
 * record as UNRECORDED, which no gate counts as a call made; a command whose
 * words the shell would expand is read by its leading command words alone.
 */
export async function reconcileRecord(): Promise<void> {
  const { harnessDir } = ctx();
  const { splitShellCommand } = await import("../../shared/contracts/permissionRules.ts");
  for (let turn = 1; turn <= turnNo; turn++) {
    const file = path.join(harnessDir, turn === 1 ? "stream.jsonl" : `stream${turn}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const have = new Set(answered.filter((a) => a.turn === turn).map((a) => a.line));
    const missing: string[][] = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"tool_use"')) continue;
      let e: any;
      try { e = JSON.parse(line); } catch { continue; }
      for (const c of e?.message?.content ?? []) {
        if (c?.type !== "tool_use" || c.name !== "Bash" || typeof c.input?.command !== "string") continue;
        const cmd: string = c.input.command;
        const split = splitShellCommand(cmd);
        const argvs = split
          ? split.flatMap((words: string[]) => { const at = words.findIndex((w) => w === "cast" || w.endsWith("/cast")); return at < 0 ? [] : [words.slice(at + 1)]; })
          : [...cmd.matchAll(/(?:^|[\s;&|(])(?:\S*\/)?cast\s+([a-z][a-z0-9-]*)(?:\s+([a-z][a-z0-9-]*))?/g)].map((m) => [m[1]!, ...(m[2] ? [m[2]] : [])]);
        for (const argv of argvs) {
          const logged = loggedArgv(argv);
          const known = split ? have.has(logged) : [...have].some((l) => l === logged || l.startsWith(`${logged} `));
          if (!known) missing.push(argv);
        }
      }
    }
    for (const argv of missing) {
      const kind = await classify(argv);
      if (kind !== "write" && !(frozen(argv) && !served(argv))) continue;
      answered.push({ turn, line: `UNRECORDED ${loggedArgv(argv)}` });
      have.add(loggedArgv(argv));
    }
  }
}

/**
 * calls.log as the run leaves it, rebuilt from this process's record alone:
 * every argv and mark the guard reported (/mark), the fake's answers, and the
 * broker's own refusals, each in its turn. The calls.log the guard wrote in
 * the run dir is the agent's to edit, so nothing in it counts. Runs once the
 * agent and everything it started are gone.
 */
export function mergeAnswered(): void {
  const { runDir, harnessDir } = ctx();
  const file = path.join(runDir, "calls.log");
  const turns = new Map<number, string[]>([[1, []]]);
  for (let t = 2; t <= turnNo; t++) turns.set(t, []);
  for (const a of answered) (turns.get(a.turn) ?? turns.set(a.turn, []).get(a.turn)!).push(a.line);
  const out = [...turns.keys()].sort((a, b) => a - b).flatMap((t) => [...(t > 1 ? [`# turn ${t}`] : []), ...turns.get(t)!]);
  fs.writeFileSync(file, out.length ? `${out.join("\n")}\n` : "");
  fs.writeFileSync(path.join(harnessDir, "answered.log"), answered.map((a) => `${a.turn} ${a.line}`).join("\n") + (answered.length ? "\n" : ""));
}
