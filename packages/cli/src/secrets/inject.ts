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
  validatePayload,
  type FilePayload,
  type KeyPayload,
  type LoginPayload,
  type SecretKind,
  type SecretPayload,
} from "@codecast/shared/contracts/secrets";
import { shellQuote } from "../shellQuote.js";

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

export type ValueOptions = { username?: string; totp?: boolean; totpFromEnv?: string; file?: string; fromEnv?: string; clear?: string[] };

/** The login fields `rotate --clear` empties, by the name the flag takes. */
export const CLEARABLE = { password: "password", username: "username", totp: "totp_seed" } as const satisfies Record<string, keyof LoginPayload>;
type Clearable = keyof typeof CLEARABLE;

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

/** A flag that belongs to another kind: `add` names the --kind that takes it; a rotate cannot change a secret's kind, so it names the way round. */
function otherKind(flag: string, kind: SecretKind, wants: SecretKind, rotate?: boolean): Error {
  return new Error(rotate
    ? `A ${kind} cannot take ${flag}, and rotate keeps a secret's kind: cast vault rm it, then add it again with --kind ${wants}`
    : `${flag} belongs to a ${wants}: add it with --kind ${wants}`);
}

/**
 * The payload a person means for `add`, `rotate` and `fill`. Every refusal is
 * a sentence about the input, never the value. Rotating a login, a blank
 * answer keeps the stored field (the server merges, mergeLogin) and each
 * `--clear` field goes as "", which empties it.
 */
export async function readPayload(kind: SecretKind, o: ValueOptions, io: ValueIO, opts: { rotate?: boolean } = {}): Promise<SecretPayload> {
  if (kind === "signin") throw new Error("A sign-in is captured from a browser, not typed: use Save sign-in on the Vault page");
  if ((o.totp || o.totpFromEnv) && kind !== "login") throw otherKind("--totp", kind, "login", opts.rotate);
  const clear = new Set<Clearable>();
  for (const c of o.clear ?? []) {
    if (kind !== "login") throw new Error("--clear empties a login's field; a key or file is replaced whole");
    if (!(c in CLEARABLE)) throw new Error(`--clear takes ${Object.keys(CLEARABLE).join(", ")}`);
    clear.add(c as Clearable);
  }
  if (clear.has("username") && o.username !== undefined) throw new Error("--clear username and --username contradict: pass one");
  if (clear.has("password") && o.fromEnv) throw new Error("--clear password and --from-env contradict: pass one");
  if (clear.has("totp") && (o.totp || o.totpFromEnv)) throw new Error("--clear totp and --totp contradict: pass one");
  if (o.file && kind !== "file") throw otherKind("--file", kind, "file", opts.rotate);
  const envVar = (name: string | undefined): string | undefined => {
    if (!name) return undefined;
    const v = io.env[name];
    if (!v) throw new Error(`${name} is not set in this environment`);
    return v;
  };
  const fromEnv = () => envVar(o.fromEnv);

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
  const blank = opts.rotate ? "blank keeps the current one" : "blank for none";
  const username = o.username ?? (io.tty && !clear.has("username") ? await io.ask(`Username (${blank}): `) : "");
  if (username.trim()) login.username = username.trim();
  const seedFromEnv = envVar(o.totpFromEnv);
  const askSeed = !!o.totp && seedFromEnv === undefined;
  const prompts = [...(o.fromEnv || clear.has("password") ? [] : [`Password (hidden, ${blank}): `]), ...(askSeed ? ["2FA setup key or otpauth:// link (hidden): "] : [])];
  const answers = prompts.length ? await io.hidden(prompts) : [];
  const password = fromEnv() ?? answers.shift();
  if (password) login.password = password;
  const seed = seedFromEnv ?? (askSeed ? answers.shift() : undefined);
  if (askSeed && !seed) {
    const how = io.tty ? "paste it at the prompt" : `pipe it as the ${o.fromEnv ? "first" : "second"} stdin line${o.fromEnv ? "" : ", after the password"}`;
    throw new Error(`--totp got no 2FA setup key (the site shows it under "can't scan the code" when you turn 2FA on): ${how}, or pass --totp-from-env VAR`);
  }
  if (seed) login.totp_seed = seed;
  for (const c of clear) login[CLEARABLE[c]] = "";
  return login;
}

/**
 * A rotate's login checked the way a new one is (validatePayload), except
 * that it need not be whole: the fields it leaves out keep their stored
 * values on the server, and the cleared ones ("") are sent as "".
 */
export function validateLoginChange(raw: LoginPayload): { payload: LoginPayload } | { error: string } {
  const typed = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== ""));
  const cleared = Object.fromEntries(Object.entries(raw).filter(([, v]) => v === ""));
  if (!Object.keys(typed).length) {
    return Object.keys(cleared).length ? { payload: cleared } : { error: `Nothing to change: give a new value, or empty a field with --clear ${Object.keys(CLEARABLE).join("|")}` };
  }
  const checked = validatePayload("login", typed);
  return "error" in checked ? checked : { payload: { ...checked.payload, ...cleared } };
}

// ── Giving values out ───────────────────────────────────────────────────────

/** Every field `get --field` takes. */
export const GET_FIELDS = ["value", "username", "password", "totp", "content"] as const;
export type GetField = (typeof GET_FIELDS)[number];

/** The fields each kind has, the default first; a sign-in has none. A login's 2FA code (totp) is computed, so only `get` adds it. */
export const KIND_FIELDS: Record<SecretKind, readonly Exclude<GetField, "totp">[]> = { key: ["value"], login: ["password", "username"], file: ["content"], signin: [] };

/** The field `get` prints by default: the one value a kind is about. Every default (an env var a secret fills, a bare vault:// reference) starts here. */
export function defaultField(kind: SecretKind): Exclude<GetField, "totp"> | null {
  return KIND_FIELDS[kind][0] ?? null;
}

const signinHasNoValue = (name: string) => `${name} is a saved sign-in: cast browser open <site> loads it, it has no value to print`;

/** Why `get --field` cannot give `field` from this secret's kind, naming the fields it has; null when the kind has it. */
export function getFieldRefusal(s: Pick<ReadSecret, "name" | "kind">, field: GetField): string | null {
  const fields: readonly GetField[] = s.kind === "login" ? [...KIND_FIELDS.login, "totp"] : KIND_FIELDS[s.kind];
  if (fields.includes(field)) return null;
  if (!fields.length) return signinHasNoValue(s.name);
  const list = fields.length === 1 ? fields[0] : `${fields.slice(0, -1).join(", ")} or ${fields.at(-1)}`;
  return `${s.name} is a ${s.kind}: use --field ${list} (or omit --field)`;
}

/** One field of a read secret, or the sentence saying why it has none. TOTP is computed by the caller. */
export function fieldValue(s: ReadSecret, field: Exclude<GetField, "totp">): { value: string } | { error: string } {
  const p = s.payload as KeyPayload & LoginPayload & FilePayload;
  const v = field === "value" ? (s.kind === "key" ? p.value : undefined)
    : field === "content" ? (s.kind === "file" ? p.content : undefined)
    : s.kind === "login" ? p[field] : undefined;
  if (typeof v === "string") return { value: v };
  if (s.kind === "signin") return { error: signinHasNoValue(s.name) };
  return { error: `${s.name} is a ${s.kind} with no ${field}${s.kind === "login" ? `: store one with cast vault rotate ${s.name}` : ""}` };
}

/** `export NAME='value'` lines for eval. */
export function exportLines(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`).join("\n");
}

/**
 * The value an env var takes from a secret without a field named: its default
 * field, except that a file secret gives the path of its temp file
 * (`filePath`) rather than its content. Or the sentence saying why it has none.
 */
export function primaryValue(s: ReadSecret, filePath?: string): { value: string } | { error: string } {
  if (s.kind === "file") return filePath !== undefined ? { value: filePath } : { error: `${s.name} is a file secret with no temp file` };
  return fieldValue(s, defaultField(s.kind) ?? "value");
}

/**
 * `paths`: each written file secret's temp path, by secret name. `unfilled`:
 * each mapped var whose read secret has no value for it (a login with no
 * password), with the sentence saying why.
 */
export type Materialized = {
  env: Record<string, string>;
  skipped: string[];
  unfilled: { envVar: string; secret: string; error: string }[];
  paths: Map<string, string>;
  cleanup: () => void;
};

const TEMP_PREFIX = "cast-vault-";
/** A temp directory from before its name carried its owner's pid is removed once it is this old. */
export const LEGACY_TEMP_MS = 60 * 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove the file secrets an earlier run left on disk when it died without
 * cleaning up (kill -9, a crash, power loss): each `cast-vault-<pid>-*`
 * directory of this user whose pid is gone, and an older unnamed one past
 * LEGACY_TEMP_MS. A directory whose run is still alive stays, however long
 * that run lasts.
 */
export function sweepStaleTemp(root: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = path.join(root, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) continue;
      const pid = Number(/^cast-vault-(\d+)-/.exec(name)?.[1] ?? 0);
      if (pid ? !alive(pid) : now - st.mtimeMs > LEGACY_TEMP_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * The env a set of read secrets gives a child. A file secret is written to a
 * 0600 file in a fresh 0700 directory named for this process, and its path is
 * the value; `cleanup` removes the directory, and so does any throw here.
 * Writing one first sweeps what dead runs left (sweepStaleTemp). With `map`
 * (a project's [vault]), each mapped var takes its secret's primary value;
 * the secrets in `named` (refs given on the command line) then add their own
 * env names on top, so a named secret wins a var both set. Without a map
 * every secret counts as named.
 * `writeFiles: false` (for `env`, whose output outlives this process) skips
 * file secrets rather than leave a value on disk.
 */
export function materialize(
  secrets: ReadSecret[],
  opts: { map?: Record<string, string> | null; named?: readonly string[]; writeFiles?: boolean; tmpRoot?: string } = {},
): Materialized {
  const writeFiles = opts.writeFiles ?? true;
  const root = opts.tmpRoot ?? os.tmpdir();
  let dir: string | null = null;
  const cleanup = () => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  };
  const paths = new Map<string, string>();
  const skipped = new Set<string>();
  const unfilled: Materialized["unfilled"] = [];
  const env: Record<string, string> = {};
  try {
    for (const s of secrets) {
      if (s.kind !== "file") continue;
      if (!writeFiles) {
        skipped.add(s.name);
        continue;
      }
      if (!dir) {
        sweepStaleTemp(root);
        dir = fs.mkdtempSync(path.join(root, `${TEMP_PREFIX}${process.pid}-`));
      }
      const own = path.join(dir, s.name);
      fs.mkdirSync(own, { mode: 0o700 });
      const file = path.join(own, path.basename((s.payload as FilePayload).filename || s.name));
      fs.writeFileSync(file, (s.payload as FilePayload).content, { mode: 0o600 });
      paths.set(s.name, file);
    }
    const byName = new Map(secrets.map((s) => [s.name, s]));
    for (const [v, name] of Object.entries(opts.map ?? {})) {
      const s = byName.get(name);
      if (!s) continue;
      // A sign-in has no value, and a file not written (env) is left out: both are named in `skipped`.
      if (s.kind === "signin" || (s.kind === "file" && !paths.has(name))) {
        skipped.add(name);
        continue;
      }
      const got = primaryValue(s, paths.get(name));
      if ("value" in got) env[v] = got.value;
      else unfilled.push({ envVar: v, secret: name, error: got.error });
    }
    const named = (s: ReadSecret) => !opts.map || !!opts.named?.some((r) => r === s.name || r === s.short_id || r === s.id);
    for (const s of secrets.filter(named)) {
      if (s.kind === "signin") skipped.add(s.name);
      else if (s.kind !== "file" || paths.has(s.name)) Object.assign(env, envValues(s, s.payload, paths.get(s.name)));
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  return { env, skipped: [...skipped], unfilled, paths, cleanup };
}

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
/** The keys a terminal sends to its whole foreground process group, child included. */
const FROM_TERMINAL = new Set<NodeJS.Signals>(["SIGINT", "SIGQUIT"]);

/**
 * Run `command` with `env` on top of ours, forward the signals a wrapper
 * should, and resolve with the exit code a shell would report (128 + n for a
 * signal). `cleanup` runs once the child is gone, however it went. On a
 * terminal (`tty`), Ctrl-C and Ctrl-\ already reach the child from the
 * terminal, so they are only held here while the child decides; forwarding
 * them too would deliver each twice.
 */
export function runWith(command: string[], env: Record<string, string>, cleanup: () => void, tty: boolean = !!process.stdin.isTTY): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", env: { ...process.env, ...env } });
    const forward = (sig: NodeJS.Signals) => () => {
      if (!(tty && FROM_TERMINAL.has(sig))) child.kill(sig);
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
