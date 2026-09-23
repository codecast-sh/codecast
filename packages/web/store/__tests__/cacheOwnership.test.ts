import { expect, it } from "bun:test";

// The disk cache belongs to one account. Each scenario boots the real cache in
// its own process (module singletons) against a seeded disk and token; see
// fixtures/cacheOwnership.ts for what each one asserts.
for (const scenario of [
  "fresh",
  "known-owner",
  "legacy-unknown-owner",
  "foreign-owner",
  "signed-out-residue",
  "durable-only-token",
  "write-guard-race",
]) {
  it(`cache ownership: ${scenario}`, () => {
    const result = Bun.spawnSync([process.execPath, `${import.meta.dir}/fixtures/cacheOwnership.ts`], {
      stdout: "pipe", stderr: "pipe", timeout: 20000, env: { ...process.env, SCENARIO: scenario },
    });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toContain(`${scenario} verified`);
  }, 25000);
}
