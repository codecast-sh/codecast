import * as crypto from "crypto";
import * as os from "os";

const SALT_LEN = 16;
const IV_LEN = 12;
const AUTH_TAG_LEN = 16;
const KEY_LEN = 32;
const HEADER_LEN = SALT_LEN + IV_LEN + AUTH_TAG_LEN;
const ENC_PREFIX = "enc:";

function getMachineId(): string {
  const home = os.homedir();
  const platform = os.platform();
  const hostname = os.hostname();
  return crypto
    .createHash("sha256")
    .update(`${hostname}:${platform}:${home}`)
    .digest("hex");
}

function deriveKey(salt: Buffer): Buffer {
  return crypto.scryptSync(getMachineId(), salt, KEY_LEN);
}

export function encryptToken(token: string): string {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(salt);
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
    throw new Error("Invalid encrypted token");
  }
  const salt = buf.subarray(0, SALT_LEN);
  const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const authTag = buf.subarray(SALT_LEN + IV_LEN, HEADER_LEN);
  const ciphertext = buf.subarray(HEADER_LEN);
  const key = deriveKey(salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final("utf8");
}

export function isEncryptedToken(value: string): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}
