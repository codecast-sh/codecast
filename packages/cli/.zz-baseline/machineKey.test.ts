import { describe, it, expect } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveMachineKey, MACHINE_KEY_LEN } from "./machineKey.js";
import { encryptTokenWithSecret, decryptTokenWithSecrets, TokenDecryptError } from "./tokenEncryption.js";

const HW_A = () => "AAAAAAAA-1111-2222-3333-444444444444";
const HW_B = () => "BBBBBBBB-5555-6666-7777-888888888888";
const HW_NONE = () => "";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codecast-mk-"));
}

/** Simulate Migration Assistant: copy the whole ~/.codecast identity onto new hardware. */
function cloneDir(src: string): string {
  const dst = tmpDir();
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  return dst;
}

describe("machineKey hardware binding", () => {
  it("creates a key and hostid sidecar on first run, stable afterwards", () => {
    const dir = tmpDir();
    const first = resolveMachineKey(dir, HW_A);
    expect(first.secret.length).toBe(MACHINE_KEY_LEN);
    expect(first.rotated).toBe(false);
    expect(fs.existsSync(path.join(dir, ".machine_key.hostid"))).toBe(true);

    const second = resolveMachineKey(dir, HW_A);
    expect(second.secret.equals(first.secret)).toBe(true);
    expect(second.rotated).toBe(false);
  });

  it("adopts a pre-binding key without changing it (upgrade path)", () => {
    const dir = tmpDir();
    const legacyKey = crypto.randomBytes(MACHINE_KEY_LEN);
    fs.writeFileSync(path.join(dir, ".machine_key"), legacyKey, { mode: 0o600 });

    const result = resolveMachineKey(dir, HW_A);
    expect(result.secret.equals(legacyKey)).toBe(true);
    expect(result.rotated).toBe(false);
    expect(fs.existsSync(path.join(dir, ".machine_key.hostid"))).toBe(true);
  });

  it("rotates when the key lands on different hardware (Migration Assistant clone)", () => {
    const macA = tmpDir();
    const original = resolveMachineKey(macA, HW_A);

    const macB = cloneDir(macA);
    const cloned = resolveMachineKey(macB, HW_B);

    expect(cloned.rotated).toBe(true);
    expect(cloned.secret.equals(original.secret)).toBe(false);
    expect(cloned.previousSecret!.equals(original.secret)).toBe(true);

    // Device ids (sha256 of the secret) diverge — the collision is gone.
    const idOf = (s: Buffer) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
    expect(idOf(cloned.secret)).not.toBe(idOf(original.secret));

    // Mac A is untouched and stable.
    const originalAgain = resolveMachineKey(macA, HW_A);
    expect(originalAgain.secret.equals(original.secret)).toBe(true);
    expect(originalAgain.rotated).toBe(false);

    // Mac B is stable after the one-time rotation, prev still available.
    const clonedAgain = resolveMachineKey(macB, HW_B);
    expect(clonedAgain.secret.equals(cloned.secret)).toBe(true);
    expect(clonedAgain.rotated).toBe(false);
    expect(clonedAgain.previousSecret!.equals(original.secret)).toBe(true);
  });

  it("rotation is deterministic — concurrent detectors converge on the same key", () => {
    const macA = tmpDir();
    resolveMachineKey(macA, HW_A);

    const clone1 = resolveMachineKey(cloneDir(macA), HW_B);
    const clone2 = resolveMachineKey(cloneDir(macA), HW_B);
    expect(clone1.secret.equals(clone2.secret)).toBe(true);
  });

  it("recovers from a rotation interrupted before the sidecar write", () => {
    const macA = tmpDir();
    const original = resolveMachineKey(macA, HW_A);

    const macB = cloneDir(macA);
    const rotated = resolveMachineKey(macB, HW_B);

    // Rewind the sidecar to Mac A's hostid, as if the rotation crashed after
    // writing key+prev but before the sidecar.
    fs.copyFileSync(path.join(macA, ".machine_key.hostid"), path.join(macB, ".machine_key.hostid"));

    const recovered = resolveMachineKey(macB, HW_B);
    // Must finish the interrupted rotation, not rotate a second time.
    expect(recovered.secret.equals(rotated.secret)).toBe(true);
    // prev must NOT be clobbered — it still holds the original key.
    expect(recovered.previousSecret!.equals(original.secret)).toBe(true);
  });

  it("never rotates when no hardware id is available", () => {
    const dir = tmpDir();
    const first = resolveMachineKey(dir, HW_NONE);
    expect(fs.existsSync(path.join(dir, ".machine_key.hostid"))).toBe(false);

    // Even with a foreign sidecar present, no hardware id → no rotation.
    fs.writeFileSync(path.join(dir, ".machine_key.hostid"), "deadbeef\n");
    const second = resolveMachineKey(dir, HW_NONE);
    expect(second.secret.equals(first.secret)).toBe(true);
    expect(second.rotated).toBe(false);
  });

  it("auth token encrypted before rotation still decrypts via previousSecret", () => {
    const macA = tmpDir();
    const original = resolveMachineKey(macA, HW_A);
    const token = "cxt_migrated_token_value";
    const encrypted = encryptTokenWithSecret(token, original.secret.subarray(0, MACHINE_KEY_LEN));

    const cloned = resolveMachineKey(cloneDir(macA), HW_B);
    const chain = [
      cloned.secret.subarray(0, MACHINE_KEY_LEN),
      cloned.previousSecret!.subarray(0, MACHINE_KEY_LEN),
    ];
    expect(decryptTokenWithSecrets(encrypted, chain)).toBe(token);

    // Without the previous key the rotated machine could not decrypt.
    expect(() => decryptTokenWithSecrets(encrypted, [chain[0]])).toThrow(TokenDecryptError);
  });
});
