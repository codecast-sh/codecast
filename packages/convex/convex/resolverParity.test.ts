import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { resolveCapabilities } from "@codecast/shared/contracts";

// Convex's leg of the resolver parity triangle — the desired-set computation
// the server will run reads the same shared module, so this suite pins that
// the module resolved FROM THIS PACKAGE answers identically to the fixtures.
// See shared/contracts/capabilityResolver.golden.test.ts for the argument.

const DIR = path.join(
  __dirname,
  "..", "..", "shared", "contracts", "__fixtures__", "resolver",
);

describe("resolver golden parity (convex runtime)", () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();

  it("the fixture set is present and non-trivial", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  for (const f of files) {
    it(`byte-identical on ${f}`, () => {
      const { input, output } = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf-8"));
      const actual = resolveCapabilities(input.bindings, input.context);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(output));
    });
  }
});
