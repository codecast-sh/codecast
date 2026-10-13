// Redaction by known value: the second half of transcript redaction.
//
// secretRedaction.ts catches secrets by SHAPE (vendor prefixes, PEM blocks,
// `NAME_SECRET=…` assignments). A secret with no recognizable shape (a random
// password, an internal service token) passes those patterns untouched. This
// module closes that gap the way Delta does: the daemon collects the real
// secret values present on this machine (its environment, codecast's own
// config, the standard credential files, and the .env files of live sessions'
// working directories) and replaces every exact occurrence before a transcript
// syncs.
//
// Rules:
//  - Values live only in memory. Nothing here logs, persists or sends a value;
//    log lines name sources and counts only.
//  - Only the files listed in CREDENTIAL_FILES, codecast's config dir, and
//    `.env` / `.env.*` in a tracked cwd (and its git root) are ever read.
//  - Length floors keep common words from being "secrets": 8 chars minimum,
//    12 when the value is all digits, 16 when it is letters only (a plain word
//    or identifier like `development` or `postgres_user`).
//  - Matches are exact, longest first, never overlapping, and each becomes
//    `[redacted:known]` or `[redacted:known:NAME]`. Markers cannot contain a
//    known value (values must clear the floors above and markers are built from
//    the fixed prefix plus a variable name), so a second pass is a no-op.
//
// The store is empty until the daemon calls startKnownValueRedaction, so
// redactKnownValues is a pass-through in every other process.

import * as fs from "node:fs";
import * as path from "node:path";

export type KnownValue = { value: string; name?: string };

/** Variable names whose values are credentials. AUTH excludes AUTHOR (GIT_AUTHOR_NAME). */
const SECRET_NAME_RE = /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH(?!OR)/i;

const MIN_LENGTH = 8;
const MIN_DIGITS_ONLY = 12;
const MIN_LETTERS_ONLY = 16;
// A credential is one token. Anything this long is a document, not a secret
// worth exact-matching (a kubeconfig cert blob is the usual case).
const MAX_LENGTH = 8192;

/** True if `value` is long and varied enough to be redacted wherever it appears. */
export function qualifiesAsKnownValue(value: string): boolean {
  if (value.length < MIN_LENGTH || value.length > MAX_LENGTH) return false;
  if (/^\d+$/.test(value)) return value.length >= MIN_DIGITS_ONLY;
  if (/^[A-Za-z_.-]+$/.test(value)) return value.length >= MIN_LETTERS_ONLY;
  // Paths, booleans-with-padding and the like are configuration, not secrets.
  if (/^(?:\/|~\/|\.\.?\/)/.test(value)) return false;
  return true;
}

export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** The password (and user:password pair) inside a URL's userinfo, if any. */
function urlCredentials(value: string, name: string | undefined, out: KnownValue[]): void {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/\s:@]+):([^/\s@]+)@/i.exec(value);
  if (!m) return;
  let password = m[2];
  try { password = decodeURIComponent(password); } catch {}
  out.push({ value: m[2], name }, { value: password, name });
}

function add(out: KnownValue[], value: string | undefined | null, name?: string): void {
  if (typeof value !== "string") return;
  const v = value.trim();
  if (!v) return;
  out.push({ value: v, name });
  urlCredentials(v, name, out);
}

// ---------------------------------------------------------------------------
// Collectors. Each takes file text (or an env map) and returns candidates;
// the floors are applied once, when the matcher is built.

/** Environment variables whose names mark them as credentials, plus URL passwords in any variable. */
export function collectFromEnv(env: Record<string, string | undefined>): KnownValue[] {
  const out: KnownValue[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (isSecretName(name)) add(out, value, name);
    else urlCredentials(value.trim(), name, out);
  }
  return out;
}

/** Parse dotenv text into [name, value] pairs (export prefix, quotes, inline comments). */
export function parseDotenv(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'" || q === "`") && value.indexOf(q, 1) > 0) {
      value = value.slice(1, value.indexOf(q, 1));
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    pairs.push([m[1], value]);
  }
  return pairs;
}

/** A value that looks generated rather than written: long, mixed letters and digits, no spaces. */
function looksRandom(value: string): boolean {
  return value.length >= 16 && !/\s/.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * A .env file. Secret-named variables, URL passwords, and values that look
 * generated. Plain configuration (`NEXT_PUBLIC_URL=https://…`, `NODE_ENV=…`)
 * stays visible: redacting a public URL everywhere it appears in a transcript
 * would cost readability and protect nothing.
 */
export function collectFromDotenv(text: string): KnownValue[] {
  const out: KnownValue[] = [];
  for (const [name, value] of parseDotenv(text)) {
    if (isSecretName(name) || looksRandom(value)) add(out, value, name);
    else urlCredentials(value, name, out);
  }
  return out;
}

/** ~/.netrc: the token after each `password` (and `account`) keyword. */
export function collectFromNetrc(text: string): KnownValue[] {
  const out: KnownValue[] = [];
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "password" || tokens[i] === "account") add(out, tokens[i + 1], "netrc");
  }
  return out;
}

/**
 * `key <sep> value` lines whose key is credential-named. `sep` is the format's
 * separator: `=` for ini-style files (aws, npmrc), `:` for yaml (gh, kube),
 * either for pypirc. An npmrc key carries a registry scope
 * (`//registry.npmjs.org/:_authToken`); only the part after the last colon names it.
 */
export function collectFromKeyValueLines(text: string, sep: "=" | ":" | "=:", extraKeys: RegExp | null = null): KnownValue[] {
  const out: KnownValue[] = [];
  const re = sep === "="
    ? /^\s*([^\s=#;][^=]*?)\s*=\s*(.+?)\s*$/
    : sep === ":"
      ? /^\s*-?\s*([\w.-]+)\s*:\s*(.+?)\s*$/
      : /^\s*([\w.-]+)\s*[=:]\s*(.+?)\s*$/;
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw);
    if (!m) continue;
    const keyName = m[1].replace(/^.*:/, "");
    if (!isSecretName(keyName) && !(extraKeys && extraKeys.test(keyName))) continue;
    add(out, m[2].replace(/^["']|["']$/g, ""), keyName.replace(/^_+/, ""));
  }
  return out;
}

/** ~/.codecast/provider-keys.json: `{ providerId: apiKey }`, every value a key. */
export function collectFromProviderKeys(text: string): KnownValue[] {
  const out: KnownValue[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return out; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [id, v] of Object.entries(parsed)) if (typeof v === "string") add(out, v, `${id}-key`);
  return out;
}

/** ~/.docker/config.json: auths.*.auth (base64 user:pass) and identity/registry tokens. */
export function collectFromDockerConfig(text: string): KnownValue[] {
  const out: KnownValue[] = [];
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return out; }
  for (const entry of Object.values(parsed?.auths ?? {}) as any[]) {
    if (!entry || typeof entry !== "object") continue;
    add(out, entry.auth, "docker auth");
    add(out, entry.identitytoken, "docker identitytoken");
    add(out, entry.registrytoken, "docker registrytoken");
    add(out, entry.password, "docker password");
    if (typeof entry.auth === "string") {
      const decoded = Buffer.from(entry.auth, "base64").toString("utf-8");
      const colon = decoded.indexOf(":");
      if (colon > 0) add(out, decoded.slice(colon + 1), "docker password");
    }
  }
  return out;
}

/** Credential-named string fields anywhere in a JSON document (codecast's config). */
export function collectFromJson(text: string): KnownValue[] {
  const out: KnownValue[] = [];
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return out; }
  const walk = (node: unknown, key: string | null, depth: number) => {
    if (depth > 6 || node == null) return;
    if (typeof node === "string") { if (key && isSecretName(key)) add(out, node, key); return; }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, Array.isArray(node) ? key : k, depth + 1);
  };
  walk(parsed, null, 0);
  return out;
}

type Collector = (text: string) => KnownValue[];

/** Every credential file read, relative to HOME. Nothing outside this list (plus codecast's dir and session .env files) is read. */
export const CREDENTIAL_FILES: Array<{ rel: string; collect: Collector }> = [
  { rel: ".netrc", collect: collectFromNetrc },
  { rel: ".aws/credentials", collect: (t) => collectFromKeyValueLines(t, "=", /^aws_(?:access_key_id|secret_access_key|session_token)$/i) },
  { rel: ".config/gh/hosts.yml", collect: (t) => collectFromKeyValueLines(t, ":") },
  { rel: ".npmrc", collect: (t) => collectFromKeyValueLines(t, "=", /^_auth$/) },
  { rel: ".pypirc", collect: (t) => collectFromKeyValueLines(t, "=:") },
  { rel: ".docker/config.json", collect: collectFromDockerConfig },
  { rel: ".kube/config", collect: (t) => collectFromKeyValueLines(t, ":", /^client-key-data$/) },
];

// ---------------------------------------------------------------------------
// Matcher. Values are bucketed by a 31-bit hash of their first four UTF-16
// units, so a scan costs one Map probe per text position and a startsWith only
// on real prefix hits. Buckets hold longest values first, so the first hit at a
// position is the longest match there.

const markerFor = (name?: string) => {
  const label = name?.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64);
  return label ? `[redacted:known:${label}]` : "[redacted:known]";
};

type Entry = { value: string; marker: string };
export type KnownValueMatcher = { size: number; buckets: Map<number, Entry[]> };

// Kept in small-integer range so Map probes stay on V8's fast path.
const prefixKey = (s: string, i: number) =>
  (Math.imul(Math.imul(Math.imul(s.charCodeAt(i), 31) + s.charCodeAt(i + 1), 31) + s.charCodeAt(i + 2), 31) + s.charCodeAt(i + 3)) & 0x3fffffff;

export function buildMatcher(values: KnownValue[]): KnownValueMatcher {
  const byValue = new Map<string, string | undefined>();
  for (const { value, name } of values) {
    if (!qualifiesAsKnownValue(value)) continue;
    // First name wins, but a named source beats an anonymous one.
    if (!byValue.has(value) || (byValue.get(value) === undefined && name)) byValue.set(value, name);
  }
  const buckets = new Map<number, Entry[]>();
  for (const [value, name] of byValue) {
    const key = prefixKey(value, 0);
    const list = buckets.get(key) ?? [];
    list.push({ value, marker: markerFor(name) });
    buckets.set(key, list);
  }
  for (const list of buckets.values()) list.sort((a, b) => b.value.length - a.value.length);
  return { size: byValue.size, buckets };
}

export function redactWithMatcher(text: string, matcher: KnownValueMatcher): string {
  if (!matcher.size || text.length < MIN_LENGTH) return text;
  const { buckets } = matcher;
  let out = "";
  let last = 0;
  const end = text.length - MIN_LENGTH + 1;
  for (let i = 0; i < end; i++) {
    const list = buckets.get(prefixKey(text, i));
    if (!list) continue;
    for (const entry of list) {
      if (text.startsWith(entry.value, i)) {
        out += text.slice(last, i) + entry.marker;
        last = i + entry.value.length;
        i = last - 1;
        break;
      }
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

// ---------------------------------------------------------------------------
// The daemon's store.

let active: KnownValueMatcher | null = null;

/** Replace exact occurrences of this machine's known secret values. A pass-through until the daemon starts the store. */
export function redactKnownValues(text: string): string {
  return active ? redactWithMatcher(text, active) : text;
}

/** Test seam: install values directly (null clears). */
export function setKnownValuesForTest(values: KnownValue[] | null): void {
  active = values ? buildMatcher(values) : null;
}

export type KnownValueSources = {
  home: string;
  configDir: string;
  env: () => Record<string, string | undefined>;
  /** Working directories of live sessions, read on each refresh. */
  cwds?: () => Iterable<string>;
  /** Decrypted codecast credentials (config.json's auth_token is encrypted at rest). */
  codecastSecrets?: () => Array<string | undefined>;
  log?: (line: string) => void;
};

function readSmall(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** The git root above `dir`, or null. Stops at the filesystem root. */
function gitRoot(dir: string): string | null {
  let cur = dir;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

const ENV_FILE_RE = /^\.env(?:\.(?!example$|sample$|template$|dist$|defaults$)[A-Za-z0-9_.-]+)?$/;

/** `.env` and `.env.*` (not `.env.example` and other templates) directly inside `dir`. */
export function envFilesIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => ENV_FILE_RE.test(f)).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export class KnownValueStore {
  private cwds = new Set<string>();
  private watched = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private rebuildQueued = false;
  // Parsed values per file, reused while the file's mtime and size hold, so a
  // boot that tracks many cwds one by one rereads only what changed.
  private parsed = new Map<string, { mtimeMs: number; size: number; values: KnownValue[] }>();
  private roots = new Map<string, string | null>();

  constructor(private readonly src: KnownValueSources) {}

  /** Files this store reads: credential files, codecast config, and session .env files. */
  files(): Array<{ file: string; collect: Collector }> {
    const files = CREDENTIAL_FILES.map(({ rel, collect }) => ({ file: path.join(this.src.home, rel), collect }));
    files.push({ file: path.join(this.src.configDir, "config.json"), collect: collectFromJson });
    files.push({ file: path.join(this.src.configDir, "provider-keys.json"), collect: collectFromProviderKeys });
    const dirs = new Set<string>();
    for (const cwd of this.cwds) {
      dirs.add(cwd);
      if (!this.roots.has(cwd)) this.roots.set(cwd, gitRoot(cwd));
      const root = this.roots.get(cwd);
      if (root) dirs.add(root);
    }
    for (const dir of dirs) for (const file of envFilesIn(dir)) files.push({ file, collect: collectFromDotenv });
    return files;
  }

  collect(): KnownValue[] {
    const values = collectFromEnv(this.src.env());
    for (const secret of this.src.codecastSecrets?.() ?? []) add(values, secret, "codecast");
    const seen = new Set<string>();
    for (const { file, collect } of this.files()) {
      seen.add(file);
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { this.parsed.delete(file); continue; }
      let hit = this.parsed.get(file);
      if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
        const text = readSmall(file);
        hit = { mtimeMs: st.mtimeMs, size: st.size, values: text == null ? [] : collect(text) };
        this.parsed.set(file, hit);
      }
      values.push(...hit.values);
    }
    for (const file of this.parsed.keys()) if (!seen.has(file)) this.parsed.delete(file);
    return values;
  }

  rebuild(): KnownValueMatcher {
    let matcher: KnownValueMatcher;
    try {
      matcher = buildMatcher(this.collect());
    } catch (e) {
      this.src.log?.(`[KNOWN-VALUES] rebuild failed: ${(e as Error)?.message ?? e}`);
      return active ?? buildMatcher([]);
    }
    const before = active?.size ?? -1;
    active = matcher;
    if (matcher.size !== before) this.src.log?.(`[KNOWN-VALUES] ${matcher.size} values from env, credential files and ${this.cwds.size} session dirs`);
    this.watchFiles();
    return matcher;
  }

  /** A session's working directory. Loads its .env files now, so its first message is covered. */
  trackCwd(cwd: string | undefined | null): void {
    if (!cwd || this.cwds.has(cwd)) return;
    this.cwds.add(cwd);
    this.rebuild();
  }

  start(intervalMs = 60_000): void {
    this.rebuild();
    this.timer = setInterval(() => {
      for (const cwd of this.src.cwds?.() ?? []) if (cwd) this.cwds.add(cwd);
      this.rebuild();
    }, intervalMs);
    (this.timer as any).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const file of this.watched) fs.unwatchFile(file);
    this.watched.clear();
    active = null;
  }

  // fs.watchFile polls stat, so it works for files that do not exist yet and
  // survives editors that replace a file on save.
  private watchFiles(): void {
    for (const { file } of this.files()) {
      if (this.watched.has(file)) continue;
      this.watched.add(file);
      fs.watchFile(file, { interval: 5_000, persistent: false }, (cur, prev) => {
        if (cur.mtimeMs === prev.mtimeMs && cur.size === prev.size) return;
        if (this.rebuildQueued) return;
        this.rebuildQueued = true;
        setTimeout(() => { this.rebuildQueued = false; this.rebuild(); }, 250).unref?.();
      });
    }
  }
}

let store: KnownValueStore | null = null;

/** Start the daemon's store (idempotent). */
export function startKnownValueRedaction(src: KnownValueSources): KnownValueStore {
  if (!store) {
    store = new KnownValueStore(src);
    store.start();
  }
  return store;
}

/** Tell the running store about a session's working directory. No-op outside the daemon. */
export function trackKnownValueCwd(cwd: string | undefined | null): void {
  store?.trackCwd(cwd);
}
