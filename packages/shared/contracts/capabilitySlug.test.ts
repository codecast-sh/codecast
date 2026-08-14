import { describe, expect, it } from "bun:test";
import {
  formatCapabilitySlug,
  parseAnyCapabilitySlug,
  parseCapabilitySlug,
  SNIPPET_CATALOG,
} from "./index";

// The namespace's one structural promise: a third party can never render a slug
// in `builtin/`, so nothing a marketplace publishes can claim a builtin's
// config key. These tests hold the grammar to that, plus the trust rule that a
// git source is always pinned.
describe("capability slug namespace", () => {
  it("every SNIPPET_CATALOG slug round-trips as builtin/<slug>", () => {
    for (const entry of SNIPPET_CATALOG) {
      const slug = `builtin/${entry.slug}`;
      const parsed = parseCapabilitySlug(slug);
      expect(parsed?.source).toBe("builtin");
      expect(parsed?.segments).toEqual([entry.slug]);
      expect(formatCapabilitySlug({ source: "builtin", segments: [entry.slug] })).toBe(slug);
    }
  });

  it("a marketplace literally named builtin cannot produce a builtin/ slug", () => {
    // The forgery attempt: a marketplace names itself "builtin" and publishes
    // "memory". Its slug still renders under mkt/, so the namespace holds.
    const forged = formatCapabilitySlug({ source: "marketplace", segments: ["builtin", "memory"] });
    expect(forged).toBe("mkt/builtin/memory");
    expect(parseCapabilitySlug(forged)?.source).toBe("marketplace");
    expect(parseCapabilitySlug("builtin/memory")?.source).toBe("builtin");
    expect(forged).not.toBe("builtin/memory");
  });

  it("parse rejects a git slug with no sha", () => {
    expect(parseAnyCapabilitySlug("git/anthropics/skills")).toBeNull();
    expect(parseCapabilitySlug("git/anthropics/skills")).toBeNull();
    // Pinned, it parses — and carries the pin and subpath apart.
    const pinned = parseCapabilitySlug("git/anthropics/skills@30287f5#skills/pdf");
    expect(pinned?.pin).toBe("30287f5");
    expect(pinned?.subpath).toBe("skills/pdf");
  });
});
