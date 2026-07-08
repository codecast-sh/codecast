/**
 * Machine key lifecycle — the single owner of ~/.codecast/.machine_key.
 *
 * The key is a random 32-byte secret that anchors this machine's identity:
 * token encryption derives its cipher key from it (tokenEncryption.ts) and
 * device_id is a hash of it (remote/device.ts). Because it's a plain file,
 * whole-disk migration tools (macOS Migration Assistant, dd, Time Machine
 * restore onto new hardware) copy it verbatim — both machines then derive the
 * same device_id, and every owner_device_id gate in the daemon treats them as
 * one machine (split-brain delivery, both daemons fighting over sessions).
 *
 * Defense: bind the key to the hardware it was created on. A sidecar
 * (.machine_key.hostid) records a hash of the machine's hardware UUID; the
 * sidecar travels with the key when cloned, so a mismatch on load means "this
 * key file was born on different hardware" → rotate. The rotated key is
 * HMAC(oldKey, hostid) — deterministic, so concurrent processes detecting the
 * clone converge on the same new key without locking. The pre-rotation key is
 * kept (.machine_key.prev) so the cloned auth token still decrypts; it gets
 * re-encrypted under the new key on the next config write.
 *
 * Existing installs adopt silently: first run writes the sidecar for the
 * current hardware and the key (and device_id) never changes. Machines where
 * no hardware id is available never rotate — binding is a clone detector, not
 * a requirement.
 */

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MACHINE_KEY_LEN = 32;

const KEY_BASENAME = ".machine_key";
const HOSTID_BASENAME = ".machine_key.hostid";
const PREV_BASENAME = ".machine_key.prev";

export interface MachineKeyResult {
  /** Full key-file bytes (>= 32). Seed for device_id; token key uses the first 32. */
  secret: Buffer;
  /** Pre-rotation key if a rotation (this run or earlier) left one — decrypt fallback. */
  previousSecret: Buffer | null;
  /** True when THIS resolution rotated the key (clone detected). Worth logging. */
  rotated: boolean;
}

let cached: MachineKeyResult | null = null;

/** Resolve the machine key against the real ~/.codecast, once per process. */
export function getMachineKey(): MachineKeyResult {
  if (cached) return cached;
  cached = resolveMachineKey(path.join(os.homedir(), ".codecast"), hardwareId);
  return cached;
}

/**
 * Full key lifecycle against an explicit directory (testable with temp dirs):
 * create on first run, adopt unbound keys, detect+rotate cloned keys.
 */
export function resolveMachineKey(dir: string, getHardwareId: () => string): MachineKeyResult {
  const keyFile = path.join(dir, KEY_BASENAME);
  const hostidFile = path.join(dir, HOSTID_BASENAME);
  const prevFile = path.join(dir, PREV_BASENAME);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  let key: Buffer | null = null;
  try {
    const existing = fs.readFileSync(keyFile);
    if (existing.length >= MACHINE_KEY_LEN) key = existing;
  } catch {}

  const hostid = hostidHash(getHardwareId());

  if (!key) {
    key = crypto.randomBytes(MACHINE_KEY_LEN);
    writeSecretFile(keyFile, key);
    if (hostid) writeSecretFile(hostidFile, hostid + "\n");
    return { secret: key, previousSecret: readPrev(prevFile), rotated: false };
  }

  // No hardware id on this platform/environment → binding disabled, key as-is.
  if (!hostid) return { secret: key, previousSecret: readPrev(prevFile), rotated: false };

  let recorded = "";
  try {
    recorded = fs.readFileSync(hostidFile, "utf8").trim();
  } catch {}

  if (!recorded) {
    // Pre-binding install: adopt this hardware as the key's rightful home.
    writeSecretFile(hostidFile, hostid + "\n");
    return { secret: key, previousSecret: readPrev(prevFile), rotated: false };
  }

  if (recorded === hostid) {
    return { secret: key, previousSecret: readPrev(prevFile), rotated: false };
  }

  // Key file was cloned from different hardware. Rotate deterministically.
  const prev = readPrev(prevFile);
  if (prev && rotateKey(prev, hostid).equals(key)) {
    // A prior rotation crashed after writing the key but before the sidecar —
    // the on-disk key is already the rotation of prev. Finish, don't re-rotate
    // (re-rotating would clobber prev and lose token decryptability).
    writeSecretFile(hostidFile, hostid + "\n");
    return { secret: key, previousSecret: prev, rotated: true };
  }

  const rotated = rotateKey(key, hostid);
  // Order matters for crash safety: prev (keeps the original recoverable) →
  // key → sidecar. A crash between any two steps re-runs this same
  // deterministic path and converges.
  writeSecretFile(prevFile, key);
  writeSecretFile(keyFile, rotated);
  writeSecretFile(hostidFile, hostid + "\n");
  return { secret: rotated, previousSecret: key, rotated: true };
}

function rotateKey(key: Buffer, hostid: string): Buffer {
  return crypto
    .createHmac("sha256", key)
    .update(`codecast-machine-key-rotation-v1:${hostid}`)
    .digest();
}

function hostidHash(raw: string): string {
  if (!raw) return "";
  return crypto.createHash("sha256").update(`codecast-hostid-v1:${raw}`).digest("hex");
}

function readPrev(prevFile: string): Buffer | null {
  try {
    const b = fs.readFileSync(prevFile);
    return b.length >= MACHINE_KEY_LEN ? b : null;
  } catch {
    return null;
  }
}

function writeSecretFile(file: string, data: Buffer | string): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

let cachedHardwareId: string | null = null;

/**
 * A stable identifier of the physical machine, or "" when unavailable.
 * macOS: IOPlatformUUID — survives OS reinstalls, never copied by Migration
 * Assistant. Linux: /etc/machine-id (regenerated by systemd on proper clones;
 * raw dd copies share it — same limitation class as the key file itself).
 * Windows: MachineGuid.
 */
export function hardwareId(): string {
  if (cachedHardwareId !== null) return cachedHardwareId;
  cachedHardwareId = detectHardwareId(process.platform);
  return cachedHardwareId;
}

function detectHardwareId(platform: NodeJS.Platform): string {
  try {
    if (platform === "darwin") {
      const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/);
      return m ? m[1].toUpperCase() : "";
    }
    if (platform === "linux") {
      for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
          const v = fs.readFileSync(p, "utf8").trim();
          if (v) return v;
        } catch {}
      }
      return "";
    }
    if (platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      return m ? m[1] : "";
    }
  } catch {}
  return "";
}
