// The execution badge on a catalog card.
//
// `ExecutionSurface` used to name two different things: the shared contract's
// eight observable surfaces, and this UI's three-way display bucket. One
// exported name for two concepts is how a reassuring badge ends up on a
// capability that the consent gate would have stopped. The bucket is now
// `ExecutionConfidence`, and it is DERIVED from the gate rather than decided
// again beside it.
//
// These tests are written to fail if the badge and the gate can ever disagree,
// not to agree with whatever the code does today.

import { describe, expect, test } from "bun:test";
import {
  EXECUTION_SURFACES,
  requiresExplicitConsent,
  type ExecutionSurface,
} from "@codecast/shared/contracts";
import {
  confidenceFromSurfaces,
  confidenceFromKind,
  entryConfidence,
} from "../CapabilityCard";

/** Every subset of the contract's surfaces — 2^8, small enough to just do. */
function allSurfaceSets(): ExecutionSurface[][] {
  const sets: ExecutionSurface[][] = [];
  for (let mask = 0; mask < 1 << EXECUTION_SURFACES.length; mask++) {
    sets.push(EXECUTION_SURFACES.filter((_, i) => mask & (1 << i)));
  }
  return sets;
}

describe("the execution badge cannot contradict the consent gate", () => {
  test("every possible surface set renders code exactly when consent is required", () => {
    const sets = allSurfaceSets();
    expect(sets).toHaveLength(256);
    for (const surfaces of sets) {
      expect({
        surfaces,
        badge: confidenceFromSurfaces(surfaces),
      }).toEqual({
        surfaces,
        badge: requiresExplicitConsent(surfaces) ? "code" : "prose",
      });
    }
  });

  test("a capability needing consent is never rendered as prose", () => {
    const gated = allSurfaceSets().filter((s) => requiresExplicitConsent(s));
    // 253 of the 256: only the three non-empty subsets of {prose, reads_files}
    // are benign, and the empty set counts as gated.
    expect(gated.length).toBe(253);
    for (const surfaces of gated) {
      expect(confidenceFromSurfaces(surfaces)).toBe("code");
      expect(confidenceFromSurfaces(surfaces)).not.toBe("prose");
    }
  });

  test("an empty classification is code, never prose", () => {
    // The contract's deliberate rule: nothing observed is treated as dangerous,
    // because the alternative turns a failed scan into a silent install.
    expect(requiresExplicitConsent([])).toBe(true);
    expect(confidenceFromSurfaces([])).toBe("code");
  });

  test("surfaces never looked at are unknown, which is not prose", () => {
    // Undefined means no scan has run. Rendering that as prose would be the same
    // lie as an empty classification, one step earlier.
    expect(confidenceFromSurfaces(undefined)).toBe("unknown");
  });
});

describe("the kind floor", () => {
  test("never calls an uninspected kind safe", () => {
    expect(confidenceFromKind("snippet")).toBe("prose");
    for (const kind of ["mcp", "hook", "plugin"]) {
      expect(confidenceFromKind(kind)).toBe("code");
    }
    // A skill can ship a bin; a command can declare allowed-tools and shell out.
    // Both look like markdown from the outside, so neither may read as prose.
    for (const kind of ["skill", "command", "subagent", "something-new"]) {
      expect(confidenceFromKind(kind)).toBe("unknown");
    }
  });
});

describe("entryConfidence", () => {
  test("observed surfaces beat the kind floor in both directions", () => {
    // A snippet whose scan found a script is code, even though the floor for
    // snippets is prose. The floor is a guess; the scan is a finding.
    expect(entryConfidence({ kind: "snippet", surfaces: ["ships_scripts"] })).toBe("code");
    // And an MCP server observed to be prose only is prose, though the floor
    // would have said code.
    expect(entryConfidence({ kind: "mcp", surfaces: ["prose"] })).toBe("prose");
  });

  test("falls back to the kind floor when nothing has looked", () => {
    expect(entryConfidence({ kind: "skill" })).toBe("unknown");
    expect(entryConfidence({ kind: "mcp" })).toBe("code");
    expect(entryConfidence({ kind: "snippet" })).toBe("prose");
  });

  test("a surface this build does not model is code, never prose", () => {
    // `webCatalogList` copies unvalidated keys off a publisher's `entry_json`
    // onto the card, so `surfaces` can carry anything. A stranger alongside
    // benign surfaces must not be quietly dropped — that would turn a row we
    // understand LESS well into a safer-looking badge.
    const entry = { kind: "skill", surfaces: ["prose", "teleports" as never] };
    expect(entryConfidence(entry)).toBe("code");
    expect(entryConfidence({ kind: "snippet", surfaces: ["teleports" as never] })).toBe("code");
  });

  test("a surfaces field that is not a list is a failed read, so code", () => {
    // Same untrusted-bytes path. A publisher writing `surfaces: "prose"` must
    // not be read as a one-element scan, and must not fall to the kind floor
    // either: a value we cannot read is a scan result we lost, and a snippet
    // would land on prose on the strength of bytes nobody could parse.
    expect(entryConfidence({ kind: "snippet", surfaces: "prose" as never })).toBe("code");
    expect(entryConfidence({ kind: "skill", surfaces: 7 as never })).toBe("code");
  });

  test("only absent and null mean nobody looked", () => {
    // JSON's two spellings of no value are the only ones that reach the kind
    // floor. Every card today takes this path, so widening it would badge the
    // whole catalog "runs code" and teach the reader to ignore the mark.
    expect(entryConfidence({ kind: "skill" })).toBe("unknown");
    expect(entryConfidence({ kind: "skill", surfaces: null as never })).toBe("unknown");
    expect(entryConfidence({ kind: "snippet", surfaces: null as never })).toBe("prose");
  });

  test("an entry scanned and found to have nothing is code, not the kind floor", () => {
    // An empty array is a completed scan that classified nothing — the gate
    // calls that dangerous, so the badge must too. Reading it as "no surfaces,
    // so use the floor" would render a skill as merely uninspected.
    expect(entryConfidence({ kind: "skill", surfaces: [] })).toBe("code");
  });
});
