// The fake helper's capability table has to equal the one the Swift helper
// reports. A hand copy drifted once already (drag flipped to true in Swift and
// stayed false in the fake), and the e2e tests that read the real helper run
// only on a granted Mac, so this reads the Swift source instead.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { FAKE_SUPPORTS } from "./__fixtures__/fakeSupports";

const SWIFT = new URL(
  "../../native/computer-use-macos/Sources/CodecastComputerUseCore/ProviderCapabilities.swift",
  import.meta.url,
);

/**
 * `supports` as the Swift helper encodes it: each nested struct's
 * `public var name = true|false` lines, keyed by the Supports field that holds
 * the struct (`public var apps = Apps()`).
 */
function parseSwiftSupports(source: string): Record<string, Record<string, boolean>> {
  const structs = new Map<string, Record<string, boolean>>();
  const fieldsOf = new Map<string, Array<[string, string]>>();
  // The nested structs sit one level in, so their closing brace is the first
  // line holding four spaces and a brace.
  for (const block of source.matchAll(/^    public struct (\w+)\b[^{]*\{([\s\S]*?)^    \}/gm)) {
    const [, name, body] = block;
    const flags: Record<string, boolean> = {};
    for (const [, field, value] of body.matchAll(/public var (\w+) = (true|false)\b/g)) flags[field] = value === "true";
    structs.set(name, flags);
    fieldsOf.set(name, [...body.matchAll(/public var (\w+) = (\w+)\(\)/g)].map(([, field, type]) => [field, type]));
  }
  const supports: Record<string, Record<string, boolean>> = {};
  for (const [field, type] of fieldsOf.get("Supports") ?? []) {
    const flags = structs.get(type);
    if (!flags) throw new Error(`Supports.${field} names ${type}, which the parser did not find`);
    supports[field] = flags;
  }
  return supports;
}

describe("fake helper capabilities", () => {
  test("equal the Swift helper's ProviderCapabilities", () => {
    const swift = parseSwiftSupports(readFileSync(SWIFT, "utf8"));
    expect(Object.keys(swift).length).toBeGreaterThan(0);
    expect(FAKE_SUPPORTS as Record<string, Record<string, boolean>>).toEqual(swift);
  });

  // The parser has to see a flip, or the guard above passes on anything.
  test("a flag flipped in Swift reads as a different table", () => {
    const source = readFileSync(SWIFT, "utf8");
    const flipped = source.replace("public var drag = true", "public var drag = false");
    expect(flipped).not.toBe(source);
    expect(parseSwiftSupports(flipped).actions.drag).toBe(false);
    expect(FAKE_SUPPORTS as Record<string, Record<string, boolean>>).not.toEqual(parseSwiftSupports(flipped));
  });
});
