/**
 * Every snippet in the catalog must be fully wired in the CLI.
 *
 * The catalog (packages/shared/contracts/snippets.ts) is shared by the CLI, the
 * daemon heartbeat, and the web Settings page — but the CLI holds two lookup
 * tables that a new entry has to be added to by hand, and neither failure is
 * loud:
 *
 *   - SNIPPET_BEHAVIOR maps slug → install function. A missing entry spreads
 *     `undefined`, so `cast install <slug>` dies on "install is not a function"
 *     and the wizard skips it silently.
 *   - SECTION_BY_ENABLED_KEY maps the config flag → the section to cut out on
 *     `--disable`. A missing entry means the flag flips to false while the text
 *     stays in CLAUDE.md, so the agent keeps using a capability the human just
 *     turned off. It is now derived from the catalog rather than hand-listed,
 *     and this file pins that derivation — the hand-written version had already
 *     shipped with `decide` missing.
 *
 * These are asserted against the source text because index.ts runs
 * `program.parse()` at module scope and cannot be imported.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SNIPPET_CATALOG } from "@codecast/shared/contracts";

const indexSource = fs.readFileSync(path.join(import.meta.dir, "index.ts"), "utf-8");

/**
 * Pull the VALUE of a `const NAME: SomeType = { … }` out of the source.
 *
 * Anchoring on the first `{` after the name finds the brace inside the type
 * annotation (`Record<string, { … }>`) rather than the object, which yields the
 * type's fields and makes every lookup fail — so seek past the `=` first.
 */
function tableBody(name: string): string {
  const start = indexSource.indexOf(`const ${name}`);
  expect(start).toBeGreaterThan(-1);
  const assign = indexSource.indexOf("= {", start);
  expect(assign).toBeGreaterThan(-1);
  const open = indexSource.indexOf("{", assign);
  let depth = 0;
  for (let i = open; i < indexSource.length; i++) {
    if (indexSource[i] === "{") depth++;
    else if (indexSource[i] === "}") {
      depth--;
      if (depth === 0) return indexSource.slice(open, i + 1);
    }
  }
  throw new Error(`could not find the end of ${name}`);
}

describe("every catalog snippet is wired into the CLI", () => {
  const behavior = tableBody("SNIPPET_BEHAVIOR");

  test("the behavior table was located, not silently empty", () => {
    // A source-scraping test that finds nothing passes everything. The table
    // holds ten-odd entries, so anything tiny means the extraction slipped (it
    // first grabbed the type annotation instead of the object literal).
    expect(behavior.length).toBeGreaterThan(500);
  });

  test.each(SNIPPET_CATALOG.map((s) => [s.slug, s] as const))(
    "%s has an install behavior",
    (_slug, s) => {
      expect(behavior).toContain(`${s.slug}:`);
    },
  );

  test("--disable can remove every snippet's section", () => {
    // This used to be a hand-written map, and a snippet added without a line in
    // it flipped its config flag while leaving the section in CLAUDE.md — so
    // the agent kept reading a capability the human had just turned off, with
    // no error anywhere. `decide` shipped in exactly that state. Deriving the
    // map from the catalog makes the omission impossible, so what is pinned
    // here is the derivation itself.
    expect(indexSource).toContain("SNIPPET_CATALOG.filter((d) => d.section).map((d) => [d.enabledKey, d.section!.spec])");

    // And the catalog really does carry a section for everything that has one.
    const missing = SNIPPET_CATALOG
      .filter((d) => d.slug !== "orchestration" && !d.section)
      .map((d) => d.slug);
    expect(`snippets with no installable section: ${missing.join(", ") || "none"}`).toBe(
      "snippets with no installable section: none",
    );
  });

  test("browser is present, so agents can be told the command exists", () => {
    // Guards the specific thing the feature is useless without: a capability
    // that never reaches CLAUDE.md is a capability no agent will ever call.
    const browser = SNIPPET_CATALOG.find((s) => s.slug === "browser");
    expect(browser).toBeDefined();
    expect(browser!.enabledKey).toBe("browser_enabled");
    expect(browser!.versionKey).toBe("browser_version");
  });

  test("the browser section is refreshed when the binary updates", () => {
    // Two mechanisms keep an installed section current, and a snippet needs
    // only one: refreshEnabledSnippets() reinstalls every enabled section on
    // `cast update`, and some snippets additionally carry a version-gated
    // re-check. Browser has both. (Not asserted for the whole catalog — forks,
    // for one, relies on the refresh path alone and never writes its version
    // key, so a blanket rule here would encode an invariant that is not real.)
    expect(indexSource).toContain("config.browser_enabled && config.browser_version");
    expect(indexSource).toContain("if (config.browser_enabled) installBrowserSnippet(true)");
  });
});
