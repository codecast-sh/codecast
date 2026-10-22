// The pieces of `cast vault` that touch values on this machine: reading one
// from a hidden prompt, stdin, a file or the environment (never argv), turning
// read secrets into a child's env, file secrets into 0600 temp files that live
// exactly as long as the child, and `export` lines for eval. Pure where it can
// be, so the tests hold the rules without a backend.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  envValues,
  secretNameProblem,
  type FilePayload,
  type KeyPayload,
  type LoginPayload,
  type SecretKind,
  type SecretPayload,
} from "@codecast/shared/contracts/secrets";

/** One secret as /cli/vault/read returns it. */
export type ReadSecret = {
  id: string;
  short_id: string;
  name: string;
  kind: SecretKind;
  env?: string[];
  sites?: string[];
  payload: SecretPayload;
};

// ── Reading a value in ──────────────────────────────────────────────────────

export type ValueOptions = { username?: string; totp?: boolean; file?: string; fromEnv?: string };

/** Where values come from, injectable so tests never touch a terminal. */
export interface ValueIO {
  tty: boolean;
  /** Each prompt answered with echo off on a tty; piped, one stdin line per prompt. */
  hidden: (prompts: string[]) => Promise<string[]>;
  /** A visible question (a username is not secret). */
  ask: (question: string) => Promise<string>;
  /** All of stdin, for a file secret piped in. */
  stdin: () => string;
  env: Record<string, string | undefined>;
  readFile: (p: string) => string;
}

/**
 * The payload a person means for `add`, `rotate` and `fill`. Every refusal is
 * a sentence about the input, never the value.
 */
export async function readPayload(kind: SecretKind, o: ValueOptions, io: ValueIO): Promise<SecretPayload> {
  if (kind === "signin") throw new Error("A sign-in is captured from a browser, not typed: use Save sign-in on the Vault page");
  if (o.totp && kind !== "login") throw new Error("--totp belongs to a login: add it with --kind login");
  if (o.file && kind !== "file") throw new Error("--file belongs to a file secret: add it with --kind file");
  const fromEnv = (): string | undefined => {
    if (!o.fromEnv) return undefined;
    const v = io.env[o.fromEnv];
    if (!v) throw new Error(`${o.fromEnv} is not set in this environment`);
    return v;
  };

  if (kind === "file") {
    if (o.file) {
      try {
        return { content: io.readFile(o.file), filename: path.basename(o.file) } satisfies FilePayload;
      } catch {
        throw new Error(`Cannot read ${o.file}: pass the path of a readable file`);
      }
    }
    const env = fromEnv();
    if (env !== undefined) return { content: env } satisfies FilePayload;
    if (io.tty) throw new Error("A file secret takes --file <path>, or its content piped on stdin");
    return { content: io.stdin() } satisfies FilePayload;
  }

  if (kind === "key") {
    const value = fromEnv() ?? (await io.hidden(["Value (hidden): "]))[0];
    return { value } satisfies KeyPayload;
  }

  const login: LoginPayload = {};
  const username = o.username ?? (io.tty ? await io.ask("Username (blank for none): ") : "");
  if (username.trim()) login.username = username.trim();
  const prompts = [...(o.fromEnv ? [] : ["Password (hidden, blank for none): "]), ...(o.totp ? ["2FA setup key or otpauth:// link (hidden): "] : [])];
  const answers = prompts.length ? await io.hidden(prompts) : [];
  const password = fromEnv() ?? answers.shift();
  if (password) login.password = password;
  const seed = o.totp ? answers.shift() : undefined;
  if (o.totp && !seed) throw new Error("--totp needs the site's 2FA setup key: it is under \"can't scan the code\" when you turn 2FA on");
  if (seed) login.totp_seed = seed;
  return login;
}

// ── Giving values out ───────────────────────────────────────────────────────

export type GetField = "value" | "username" | "password" | "totp" | "content";

/** The field `get` prints by default: the one value a kind is about. */
export function defaultField(kind: SecretKind): GetField | null {
  return kind === "key" ? "value" : kind === "login" ? "password" : kind === "file" ? "content" : null;
}

/** One field of a read secret, or the sentence saying why it has none. TOTP is computed by the caller. */
export function fieldValue(s: ReadSecret, field: Exclude<GetField, "totp">): { value: string } | { error: string } {
  const p = s.payload as KeyPayload & LoginPayload & FilePayload;
  const v = field === "value" ? (s.kind === "key" ? p.value : undefined)
    : field === "content" ? (s.kind === "file" ? p.content : undefined)
    : s.kind === "login" ? p[field] : undefined;
  if (typeof v === "string") return { value: v };
  if (s.kind === "signin") return { error: `${s.name} is a saved sign-in: cast browser open <site> loads it, it has no value to print` };
  return { error: `${s.name} is a ${s.kind} with no ${field}${s.kind === "login" ? `: store one with cast vault rotate ${s.name}` : ""}` };
}

/** POSIX single quoting: safe inside eval and $(…). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `export NAME='value'` lines for eval. */
export function exportLines(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join("\n");
}

/** The value a mapped env var takes from a secret: a key's value, a login's password, a file's path. */
function primaryValue(s: ReadSecret, filePath?: string): string | undefined {
  const p = s.payload as KeyPayload & LoginPayload;
  return s.kind === "key" ? p.value : s.kind === "login" ? p.password : s.kind === "file" ? filePath : undefined;
}

export type Materialized = { env: Record<string, string>; skipped: string[]; cleanup: () => void };

/**
 * The env a set of read secrets gives a child. A file secret is written to a
 * 0600 file in a fresh 0700 directory and its path is the value; `cleanup`
 * removes the directory. With `map` (a project's [vault]), each mapped var
 * takes its secret's primary value; the secrets in `named` (refs given on the
 * command line) then add their own env names on top, so a named secret wins
 * a var both set. Without a map every secret counts as named.
 * `writeFiles: false` (for `env`, whose output outlives this process) skips
 * file secrets rather than leave a value on disk.
 */
export function materialize(
  secrets: ReadSecret[],
  opts: { map?: Record<string, string> | null; named?: readonly string[]; writeFiles?: boolean; tmpRoot?: string } = {},
): Materialized {
  const writeFiles = opts.writeFiles ?? true;
  let dir: string | null = null;
  const cleanup = () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  };
  const paths = new Map<string, string>();
  const skipped = new Set<string>();
  try {
    for (const s of secrets) {
      if (s.kind !== "file") continue;
      if (!writeFiles) {
        skipped.add(s.name);
        continue;
      }
      dir ??= fs.mkdtempSync(path.join(opts.tmpRoot ?? os.tmpdir(), "cast-vault-"));
      const own = path.join(dir, s.name);
      fs.mkdirSync(own, { mode: 0o700 });
      const file = path.join(own, path.basename((s.payload as FilePayload).filename || s.name));
      fs.writeFileSync(file, (s.payload as FilePayload).content, { mode: 0o600 });
      paths.set(s.name, file);
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  const env: Record<string, string> = {};
  const map = opts.map ?? {};
  const byName = new Map(secrets.map((s) => [s.name, s]));
  for (const [v, name] of Object.entries(map)) {
    const s = byName.get(name);
    const value = s && primaryValue(s, paths.get(name));
    if (value !== undefined) env[v] = value;
    else if (s?.kind === "signin") skipped.add(name);
  }
  const named = (s: ReadSecret) => !opts.map || !!opts.named?.some((r) => r === s.name || r === s.short_id || r === s.id);
  for (const s of secrets.filter(named)) {
    if (s.kind === "signin") skipped.add(s.name);
    else if (s.kind !== "file" || paths.has(s.name)) Object.assign(env, envValues(s, s.payload, paths.get(s.name)));
  }
  return { env, skipped: [...skipped], cleanup };
}

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

/**
 * Run `command` with `env` on top of ours, forward the signals a wrapper
 * should, and resolve with the exit code a shell would report (128 + n for a
 * signal). `cleanup` runs once the child is gone, however it went.
 */
export function runWith(command: string[], env: Record<string, string>, cleanup: () => void): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env: { ...process.env, ...env } });
    const forward = (sig: NodeJS.Signals) => () => {
      child.kill(sig);
    };
    const handlers = FORWARDED.map((sig) => [sig, forward(sig)] as const);
    for (const [sig, h] of handlers) process.on(sig, h);
    // A parent killed outright still removes the files.
    process.on("exit", cleanup);
    const done = (code: number) => {
      for (const [sig, h] of handlers) process.off(sig, h);
      process.off("exit", cleanup);
      cleanup();
      resolve(code);
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      console.error(err.code === "ENOENT" ? `${command[0]}: command not found` : `${command[0]}: ${err.message}`);
      done(127);
    });
    child.on("exit", (code, signal) => done(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1)));
  });
}

// ── The old Files verbs ─────────────────────────────────────────────────────

const FILES_ONLY_VERBS = new Set(["mirror", "forget", "cat", "read", "grep", "search", "write", "edit", "mv", "links", "open", "rename"]);

const plainWord = (a: string) => /^[\w@%+=:,./~-]+$/.test(a);
const isDirectory = (p: string) => {
  try {
    return fs.statSync(p.replace(/^~(?=$|\/)/, os.homedir())).isDirectory();
  } catch {
    return false;
  }
};

/**
 * `cast vault` used to be the Files CLI. When the words after it are a Files
 * command (a Files-only verb, `add` of a directory, `rm` of a note, a bare
 * directory), the same command under `cast files`, else null.
 */
export function filesCommandFor(args: readonly string[], isDir: (p: string) => boolean = isDirectory): string | null {
  const [verb, target] = args;
  if (!verb || verb.startsWith("-")) return null;
  let rewritten: string[] | null = null;
  if (FILES_ONLY_VERBS.has(verb)) rewritten = verb === "read" ? ["cat", ...args.slice(1)] : [...args];
  else if (verb === "add" && target && !target.startsWith("-") && (secretNameProblem(target) !== null || isDir(target))) rewritten = [...args];
  else if (verb === "rm" && target && !target.startsWith("-") && secretNameProblem(target) !== null) rewritten = [...args];
  else if (secretNameProblem(verb) !== null && isDir(verb)) rewritten = ["add", ...args];
  return rewritten && `cast files ${rewritten.map((a) => (plainWord(a) ? a : shellQuote(a))).join(" ")}`;
}

/** The words after the group token in a full argv (`cast vault mirror x` → [mirror, x]). */
export function argsAfterGroup(rawArgs: readonly string[]): string[] {
  let at = 2;
  while (rawArgs[at]?.startsWith("-")) at++;
  if (rawArgs[at] === "help") return [];
  return rawArgs.slice(at + 1);
}

/** `run`'s names and command: everything after `run` up to `--`, and after it. */
export function splitRunArgs(rawArgs: readonly string[]): { names: string[]; command: string[] } | null {
  const after = argsAfterGroup(rawArgs);
  const at = after.indexOf("run");
  const rest = at >= 0 ? after.slice(at + 1) : [];
  const dash = rest.indexOf("--");
  if (dash < 0) return null;
  return { names: rest.slice(0, dash), command: rest.slice(dash + 1) };
}
