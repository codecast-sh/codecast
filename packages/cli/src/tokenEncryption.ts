import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = SALT_LEN + IV_LEN + AUTH_TAG_LEN;
const ENC_PREFIX = "enc:";

const MACHINE_KEY_DIR = path.join(os.homedir(), ".codecast");
const MACHINE_KEY_FILE = path.join(MACHINE_KEY_DIR, ".machine_key");

export class TokenDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenDecryptError";
  }
}

let cachedMachineSecret: Buffer | null = null;

function getOrCreateMachineSecret(): Buffer {
  if (cachedMachineSecret) return cachedMachineSecret;
  try {
    const existing = fs.readFileSync(MACHINE_KEY_FILE);
    if (existing.length >= KEY_LEN) {
      cachedMachineSecret = existing.subarray(0, KEY_LEN);
      return cachedMachineSecret;
    }
  } catch {}
  if (!fs.existsSync(MACHINE_KEY_DIR)) {
    fs.mkdirSync(MACHINE_KEY_DIR, { recursive: true, mode: 0o700 });
  }
  const secret = crypto.randomBytes(KEY_LEN);
  fs.writeFileSync(MACHINE_KEY_FILE, secret, { mode: 0o600 });
  try { fs.chmodSync(MACHINE_KEY_FILE, 0o600); } catch {}
  cachedMachineSecret = secret;
  return secret;
}

function legacyMachineId(): string {
  return crypto
    .createHash("sha256")
    .update(`${os.hostname()}:${os.platform()}:${os.homedir()}`)
    .digest("hex");
}

function deriveKey(salt: Buffer, secret: Buffer | string): Buffer {
  return crypto.scryptSync(secret, salt, KEY_LEN);
}

function tryDecryptWith(
  salt: Buffer,
  iv: Buffer,
  authTag: Buffer,
  ciphertext: Buffer,
  secret: Buffer | string,
): string | null {
  try {
    const key = deriveKey(salt, secret);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext) + decipher.final("utf8");
  } catch {
    return null;
  }
}

export function encryptToken(token: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(salt, getOrCreateMachineSecret());
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  const blob = Buffer.concat([salt, iv, authTag, encrypted]).toString("base64");
  return ENC_PREFIX + blob;
}

export function decryptToken(value: string): string {
  if (!isEncryptedToken(value)) return value;
  const encoded = value.slice(ENC_PREFIX.length);
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < HEADER_LEN + 1) {
    throw new TokenDecryptError("Invalid encrypted token");
  }
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = buf.subarray(SALT_LEN + IV_LEN, HEADER_LEN);
  const ciphertext = buf.subarray(HEADER_LEN);

  const fromFileKey = tryDecryptWith(salt, iv, authTag, ciphertext, getOrCreateMachineSecret());
  if (fromFileKey !== null) return fromFileKey;

  // Fall back to the legacy hostname-derived key so tokens encrypted by older
  // versions of the CLI (before the per-install machine key) still decrypt.
  const fromLegacy = tryDecryptWith(salt, iv, authTag, ciphertext, legacyMachineId());
  if (fromLegacy !== null) return fromLegacy;

  throw new TokenDecryptError(
    "Auth token cannot be decrypted on this machine. The machine identity changed (likely a hostname auto-rename by macOS) or ~/.codecast/.machine_key was deleted. Run `cast auth` to re-authenticate.",
  );
}

export function isEncryptedToken(value: string): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}
