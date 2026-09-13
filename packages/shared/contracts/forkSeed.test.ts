import { describe, expect, test } from "bun:test";
import { forkSeedClientId, isForkSeedClientId } from "./forkSeed";

describe("fork seed stamp", () => {
  test("a seed client id round-trips through the predicate", () => {
    expect(isForkSeedClientId(forkSeedClientId("forked-cli-abc"))).toBe(true);
  });

  test("ordinary client ids and missing ids are not seeds", () => {
    expect(isForkSeedClientId("web-1234")).toBe(false);
    expect(isForkSeedClientId(undefined)).toBe(false);
    expect(isForkSeedClientId(null)).toBe(false);
    expect(isForkSeedClientId("")).toBe(false);
  });
});
