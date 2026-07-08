import * as crypto from "crypto";
import * as os from "os";
import { getMachineKey } from "./machineKey.js";

const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = SALT_LEN + IV_LEN + AUTH_TAG_LEN;
const ENC_PREFIX = "enc:";

export class TokenDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenDecryptError";
  }
}

function legacyMachineId(): string {
  return crypto
    .createHash("sha256")
    .update(`${os.hostname()}:${os.platform()}:${os.homedir()}`)
    .digest("hex");
}

/**
 * Candidate secrets in decrypt order: current machine key, the pre-rotation
 * key if the machine key was rotated after a hardware clone (machineKey.ts),
 * then the legacy hostname-derived key from before the per-install key file.
 * A token that decrypts via a fallback is re-encrypted under the current key
 * the next time the config is written.
 */
function machineSecrets(): (Buffer | string)[] {
  const { secret, previousSecret } = getMachineKey();
  const secrets: (Buffer | string)[] = [secret.subarray(0, KEY_LEN)];
  if (previousSecret) secrets.push(previousSecret.subarray(0, KEY_LEN));
  secrets.push(legacyMachineId());
  return secrets;
}

function deriveKey(salt: Buffer, secret: Buffer | string): Buffer {
  return crypto.scryptSync(secret, salt, KEY_LEN);
}

export function encryptToken(token: string): string {
  return encryptTokenWithSecret(token, getMachineKey().secret.subarray(0, KEY_LEN));
}

/** encryptToken with an explicit secret — exported for tests. */
export function encryptTokenWithSecret(token: string, secret: Buffer | string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(salt, secret);
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
  return decryptTokenWithSecrets(value, machineSecrets());
}

/** decryptToken with an explicit secret chain — exported for tests. */
export function decryptTokenWithSecrets(
  value: string,
  secrets: (Buffer | string)[],
): string {
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

  for (const secret of secrets) {
    try {
      const key = deriveKey(salt, secret);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      return decipher.update(ciphertext) + decipher.final("utf8");
    } catch {}
  }

  throw new TokenDecryptError(
    "Auth token cannot be decrypted on this machine. The machine identity changed (likely a hostname auto-rename by macOS) or ~/.codecast/.machine_key was deleted. Run `cast auth` to re-authenticate.",
  );
}

export function isEncryptedToken(value: string): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}
