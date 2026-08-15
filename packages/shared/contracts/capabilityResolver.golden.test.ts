import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { resolveCapabilities } from "./capabilityResolver";

// The entire argument for a pure resolver in packages/shared is that three
// runtimes produce byte-identical answers. These fixtures are that argument
// made executable: the SAME files are read by this suite, by the CLI's suite
// (the daemon's runtime) and by convex's (the V8 runtime), so a resolver rule
// only one caller learned about fails all three in CI instead of surfacing as
// a per-machine "the toggle did not take".
//
// Regenerate DELIBERATELY after an intended rule change and show the fixture
// diff in the same commit — a fixture updated alone is indistinguishable from
// a regression goldened away.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "resolver");

export function goldenCases(): Array<{ name: string; input: any; output: any }> {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ""), ...JSON.parse(fs.readFileSync(path.join(DIR, f), "utf-8")) }));
}

describe("resolver golden parity (shared)", () => {
  const cases = goldenCases();

  it("covers every ignore reason the contract exports", () => {
    const reasons = new Set(
      cases.flatMap((c) => (c.output.ignored ?? []).map((i: any) => i.reason)),
    );
    for (const reason of [
      "scope_not_in_context",
      "client_filtered",
      "client_cannot_express",
      "loadout_not_expanded",
      "unpinned_source",
      "client_too_old",
      "malformed_binding",
    ]) {
      expect(reasons.has(reason), `no fixture produces ${reason}`).toBe(true);
    }
  });

  for (const c of goldenCases()) {
    it(`byte-identical on ${c.name}`, () => {
      const actual = resolveCapabilities(c.input.bindings, c.input.context);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(c.output));
    });
  }
});
