import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyDetached } from "../src/update/signing";

const script = join(import.meta.dir, "sign-manifest.ts");
function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, RELEASE_MANIFEST_SIGNING_KEY: "", ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("sign-manifest", () => {
  it("generates a key, signs, appends a rotated signature, and verifies with either key", () => {
    const dir = mkdtempSync(join(tmpdir(), "sign-manifest-"));
    try {
      const manifest = join(dir, "latest.json");
      writeFileSync(manifest, JSON.stringify({ version: "1.2.3", released: "2026-09-23T00:00:00Z", binaries: {} }));
      const gen = (label: string) => {
        const out = run(["--keygen"]);
        expect(out.status, label).toBe(0);
        const pem = /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/.exec(out.stdout)![0];
        const pub = out.stdout.trim().split("\n").pop()!;
        return { pem, pub };
      };
      const old = gen("old");
      const fresh = gen("new");

      expect(run(["--manifest", manifest, "--key-id", "old"]).status).toBe(2); // no key in env
      expect(run(["--manifest", manifest, "--key-id", "old"], { RELEASE_MANIFEST_SIGNING_KEY: old.pem }).status).toBe(0);
      expect(run(["--manifest", manifest, "--key-id", "new", "--append"], { RELEASE_MANIFEST_SIGNING_KEY: fresh.pem }).status).toBe(0);

      const file = JSON.parse(readFileSync(`${manifest}.sig`, "utf8"));
      expect(file.signatures.map((s: { keyId: string }) => s.keyId)).toEqual(["old", "new"]);
      const bytes = new Uint8Array(readFileSync(manifest));
      expect(verifyDetached(bytes, file.signatures[0].sig, old.pub)).toBe(true);
      expect(verifyDetached(bytes, file.signatures[1].sig, fresh.pub)).toBe(true);

      expect(run(["--verify", "--manifest", manifest, "--public-key", old.pub]).status).toBe(0);
      expect(run(["--verify", "--manifest", manifest, "--public-key", fresh.pub]).status).toBe(0);
      expect(run(["--verify", "--manifest", manifest, "--public-key", gen("stranger").pub]).status).toBe(1);

      writeFileSync(manifest, JSON.stringify({ version: "9.9.9", released: "", binaries: {} }));
      expect(run(["--verify", "--manifest", manifest, "--public-key", old.pub]).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000); // seven bun spawns; each takes a second or more on a loaded machine
});
