/**
 * Pairing Chrome profiles with the bridge host, one key per profile.
 *
 * `cast browser extension setup` mints a short one-time code (8 Crockford
 * base32 characters, 40 bits): it works once, expires in 10 minutes, and five
 * wrong attempts in a row throw every pending code away. Only a slow hash of
 * each code is kept (PBKDF2, `codes` below). The extension exchanges the code
 * for a key of its own during the handshake:
 *
 *   extension → host   hello     {mode: "code", key, nonce: Ne}
 *   host → extension   challenge {nonce: Nh}
 *   extension → host   pair      {proof: HMAC(S, "ext")}
 *   host → extension   welcome   {proof: HMAC(S, "host"), issue: K xor HMAC(S, "wrap")}
 *
 * where S = HMAC(PBKDF2(code), endpoint | Ne | Nh). Neither side shows the
 * code; a squatter on the port that collects one proof would have to run
 * PBKDF2 over every possible code before the code expires. The pad
 * HMAC(S, "wrap") is fresh per handshake, so the key K crosses the socket
 * only masked.
 *
 * From then on the profile connects with mode "key", the same mutual HMAC as
 * before (protocol.ts bridgeProof) keyed by the hash of K: the host stores
 * that hash, never K, and `extension revoke --profile <id>` deletes one
 * profile's record without touching any other. The hash is the proof key, so
 * this file is as sensitive as bridge.json and is written 0600 the same way.
 *
 * An extension paired the old way holds the machine's shared token. It
 * still connects with it (mode "legacy", or no mode at all from a store build
 * that predates profiles), and a build that knows profiles is issued its own
 * key on that connection, masked with HMAC(token, "issue:" + Ne), and drops
 * the shared token: the human's paired Chrome needs no second pairing.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { browserHome } from "../profile.js";
import { secretMatches } from "./protocol.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;
const CODE_CONTEXT = "cast-pair-v1";
/** PBKDF2 over a code: milliseconds for either side, a search over 2^40 codes that cannot finish in ten minutes. */
export const CODE_KEY_ITERATIONS = 100_000;
export const CODE_KEY_SALT = `${CODE_CONTEXT}|code`;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
export const MAX_PAIRING_FAILURES = 5;
const MAX_PENDING_CODES = 5;

/** One paired Chrome profile, keyed in the file by the extension's own stable random id. */
export interface ProfileRecord {
  /** sha256 of the profile's key, hex: the HMAC key of its handshake. */
  hash: string;
  /** What agents name it: `ashot-default`. Stable across host restarts. */
  id: string;
  /** The Chrome profile's display name, when pairing knew it. */
  name: string;
  /** The Chrome profile directory ("Default", "Profile 2"), when pairing knew it. */
  dir?: string;
  pairedAt: number;
  /** How it got its key: a one-time code, or by migrating off the shared token. */
  via: "code" | "migrated";
}

interface PendingCode {
  /** PBKDF2 of the code, hex. */
  key: string;
  expiresAt: number;
  /** The profile setup was pairing, so the record can name it. */
  dir?: string;
  name?: string;
}

export interface PairingFile {
  profiles: Record<string, ProfileRecord>;
  codes: PendingCode[];
  failures: number;
}

export function pairingPath(): string {
  return path.join(browserHome(), "bridge-profiles.json");
}

export function readPairing(now = Date.now()): PairingFile {
  try {
    const v = JSON.parse(fs.readFileSync(pairingPath(), "utf-8")) as Partial<PairingFile>;
    const profiles: Record<string, ProfileRecord> = {};
    for (const [k, r] of Object.entries(v.profiles ?? {})) {
      if (isProfileKey(k) && r && /^[0-9a-f]{64}$/.test(r.hash) && typeof r.id === "string") profiles[k] = r;
    }
    const codes = (v.codes ?? []).filter((c) => c && /^[0-9a-f]{64}$/.test(c.key) && typeof c.expiresAt === "number" && c.expiresAt >= now);
    return { profiles, codes, failures: typeof v.failures === "number" ? v.failures : 0 };
  } catch {
    return { profiles: {}, codes: [], failures: 0 };
  }
}

/** Atomic and 0600, like bridge.json: the CLI and the host both write here. */
export function writePairing(file: PairingFile): void {
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  const tmp = `${pairingPath()}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, pairingPath());
}

function updatePairing(fn: (f: PairingFile) => PairingFile): PairingFile {
  const next = fn(readPairing());
  writePairing(next);
  return next;
}

/** The extension's id for its profile: random, generated once in the profile, so it says nothing about the person. */
export function isProfileKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

// ---------------------------------------------------------------- codes

/** A typed code in canonical form (I and L read as 1, O as 0), or null. */
export function normalizePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return new RegExp(`^[${CROCKFORD}]{${CODE_LENGTH}}$`).test(code) ? code : null;
}

/** ABCD-EFGH */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The slow hash both sides derive from a code; the host stores only this. Mirrored in background.js. */
export function pairingCodeKey(code: string): string {
  return pbkdf2Sync(code, CODE_KEY_SALT, CODE_KEY_ITERATIONS, 32, "sha256").toString("hex");
}

/** A fresh one-time code for pairing the given profile; returned formatted. A new code resets the wrong-attempt count. */
export function mintPairingCode(profile?: { dir: string; name: string } | null, now = Date.now()): string {
  const code = Array.from(randomBytes(CODE_LENGTH), (b) => CROCKFORD[b & 31]).join("");
  updatePairing((f) => ({
    ...f,
    codes: [...f.codes, { key: pairingCodeKey(code), expiresAt: now + PAIRING_CODE_TTL_MS, ...(profile ? { dir: profile.dir, name: profile.name } : {}) }].slice(-MAX_PENDING_CODES),
    failures: 0,
  }));
  return formatPairingCode(code);
}

/** The key a code exchange runs under, bound to the endpoint and both nonces. */
export function codeSession(codeKey: string, port: number, extNonce: string, hostNonce: string): string {
  return createHmac("sha256", codeKey).update(`${CODE_CONTEXT}|127.0.0.1:${port}|${extNonce}|${hostNonce}`).digest("hex");
}

export function hmacHex(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("hex");
}

/** Two equal-length hex strings XORed: how a key travels masked. */
export function xorHex(a: string, b: string): string {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  if (x.length !== y.length) throw new Error("xorHex: length mismatch");
  return Buffer.from(x.map((v, i) => v ^ y[i])).toString("hex");
}

/** The pending code a pairing proof was made with, among the unexpired ones. */
export function matchPendingCode(proof: unknown, port: number, extNonce: string, hostNonce: string, now = Date.now()): { code: PendingCode; session: string } | null {
  if (typeof proof !== "string") return null;
  for (const code of readPairing(now).codes) {
    const session = codeSession(code.key, port, extNonce, hostNonce);
    if (secretMatches(hmacHex(session, "ext"), proof)) return { code, session };
  }
  return null;
}

/** Use up a code; the attempt count starts over. */
export function consumePairingCode(codeKey: string): void {
  updatePairing((f) => ({ ...f, codes: f.codes.filter((c) => c.key !== codeKey), failures: 0 }));
}

/** A wrong code. At the limit every pending code is thrown away; returns whether that happened. */
export function recordPairingFailure(): boolean {
  let exhausted = false;
  updatePairing((f) => {
    const failures = f.failures + 1;
    exhausted = failures >= MAX_PAIRING_FAILURES;
    return { ...f, codes: exhausted ? [] : f.codes, failures: exhausted ? 0 : failures };
  });
  return exhausted;
}

export function hasPendingCodes(now = Date.now()): boolean {
  return readPairing(now).codes.length > 0;
}

// ---------------------------------------------------------------- keys

export function profileKeyHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** "Ashot" in "Default" → "ashot-default"; a name alone, or "chrome" when pairing knew nothing. */
export function profileSlug(name: string | undefined, dir: string | undefined): string {
  const slug = (s: string) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const parts = [name, dir].filter((s): s is string => !!s && !!slug(s));
  const joined = [...new Set(parts.map(slug))].join("-");
  return joined.slice(0, 40).replace(/-+$/, "") || "chrome";
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * A new key for the profile `key`, replacing any it held. Its id stays when
 * it re-pairs as the same profile; otherwise it gets a fresh slug no other
 * record uses. Returns the key (to hand over masked) and the stored record.
 */
export function issueProfileKey(key: string, info: { name?: string; dir?: string; via: ProfileRecord["via"] }, now = Date.now()): { secret: string; record: ProfileRecord } {
  const secret = randomBytes(32).toString("hex");
  let record!: ProfileRecord;
  updatePairing((f) => {
    const prev = f.profiles[key];
    const taken = new Set(Object.entries(f.profiles).filter(([k]) => k !== key).map(([, r]) => r.id));
    const dir = info.dir ?? prev?.dir;
    const name = info.name ?? prev?.name ?? "Chrome";
    const id = prev && prev.dir === dir && !taken.has(prev.id) ? prev.id : uniqueId(profileSlug(info.name ?? prev?.name, dir), taken);
    record = { hash: profileKeyHash(secret), id, name, ...(dir ? { dir } : {}), pairedAt: now, via: info.via };
    return { ...f, profiles: { ...f.profiles, [key]: record } };
  });
  return { secret, record };
}

/** The profile a short id, name or key names, among the paired ones. */
export function findProfile(query: string, file = readPairing()): { key: string; record: ProfileRecord } | null {
  const q = query.trim().toLowerCase();
  for (const [key, record] of Object.entries(file.profiles)) {
    if (record.id === q || key.toLowerCase() === q || record.name.toLowerCase() === q || record.dir?.toLowerCase() === q) return { key, record };
  }
  return null;
}

/**
 * Forget one profile's key; the running host closes its socket within
 * seconds. Written until a read-back shows it gone, because the host may be
 * rewriting the file for a pairing at the same moment.
 */
export function revokeProfile(key: string): boolean {
  if (!readPairing().profiles[key]) return false;
  for (let i = 0; i < 5; i++) {
    const cur = readPairing();
    if (!cur.profiles[key]) return true;
    const rest = { ...cur.profiles };
    delete rest[key];
    writePairing({ ...cur, profiles: rest });
  }
  return !readPairing().profiles[key];
}

/** Every key and code gone: what a full `extension revoke` does alongside rotating the shared token. */
export function revokeAllProfiles(): void {
  writePairing({ profiles: {}, codes: [], failures: 0 });
}
