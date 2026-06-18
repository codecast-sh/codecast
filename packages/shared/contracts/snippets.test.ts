import { describe, expect, it } from "bun:test";
import {
  SNIPPET_CATALOG,
  snippetBySlug,
  allSnippetSlugs,
} from "./snippets";

describe("snippet catalog", () => {
  it("has unique slugs", () => {
    const slugs = SNIPPET_CATALOG.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("has unique config keys (enabledKey / versionKey)", () => {
    const enabled = SNIPPET_CATALOG.map((s) => s.enabledKey);
    const version = SNIPPET_CATALOG.map((s) => s.versionKey);
    expect(new Set(enabled).size).toBe(enabled.length);
    expect(new Set(version).size).toBe(version.length);
  });

  it("never collides a slug with another snippet's alias", () => {
    const slugs = new Set(SNIPPET_CATALOG.map((s) => s.slug));
    for (const s of SNIPPET_CATALOG) {
      for (const a of s.aliases ?? []) {
        // an alias may equal its own slug conceptually, but should not name a
        // DIFFERENT snippet's slug (that would make resolution ambiguous).
        if (slugs.has(a)) expect(a).toBe(s.slug);
      }
    }
  });

  it("resolves by slug, case-insensitively", () => {
    expect(snippetBySlug("workflows")?.enabledKey).toBe("workflow_enabled");
    expect(snippetBySlug("WORKFLOWS")?.enabledKey).toBe("workflow_enabled");
    expect(snippetBySlug("  workflows  ")?.enabledKey).toBe("workflow_enabled");
  });

  it("resolves by alias", () => {
    // The non-obvious historical mapping is exactly what the catalog protects.
    expect(snippetBySlug("schedule")?.enabledKey).toBe("task_enabled");
    expect(snippetBySlug("work")?.enabledKey).toBe("work_enabled");
    expect(snippetBySlug("orch")?.slug).toBe("orchestration");
  });

  it("returns undefined for unknown names", () => {
    expect(snippetBySlug("nope")).toBeUndefined();
    expect(snippetBySlug("stable")).toBeUndefined(); // handled specially, not a snippet
  });

  it("allSnippetSlugs mirrors the catalog order", () => {
    expect(allSnippetSlugs()).toEqual(SNIPPET_CATALOG.map((s) => s.slug));
  });
});
