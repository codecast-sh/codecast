// The doctrine sections this package ships, proved against the same engine
// that installs them — the platform's version of the donor's "shipped snippet
// bodies are recognized as our own" suite.

import { describe, expect, test } from "bun:test";
import { applySnippet, findOwnedSections, memoryFs } from "../src/index";
import { DOCTRINE, LOCAL_FIRST_STORE, stampDoctrine } from "./index";

describe("the doctrine table", () => {
  test("every section carries its heading and marker inside its body", () => {
    for (const d of DOCTRINE) {
      expect(d.section).toBeDefined();
      expect(d.section!.body).toContain(d.section!.spec.headings[0]);
      expect(d.section!.body).toContain(d.section!.spec.endMarker);
      expect(d.versionKey.endsWith("_version")).toBe(true);
    }
  });

  test("headings and markers are unique across the table", () => {
    const heads = DOCTRINE.map((d) => d.section!.spec.headings[0]);
    const ends = DOCTRINE.map((d) => d.section!.spec.endMarker);
    expect(new Set(heads).size).toBe(heads.length);
    expect(new Set(ends).size).toBe(ends.length);
  });

  // The boundary scan treats any line starting with `## ` as the next
  // section. A body that contained one below its own heading would never be
  // recognized again and every refresh would append another copy.
  test("no body contains a `## ` line below its own heading", () => {
    for (const d of DOCTRINE) {
      const afterHeading = d.section!.body.split("\n").slice(2).join("\n");
      expect(afterHeading).not.toMatch(/\n## /);
    }
  });

  test("each body installs into a real file, is found again, and refreshes to the same bytes", () => {
    for (const d of DOCTRINE) {
      const user = "# Their AGENTS.md\n\n## Their Own Section\nkeep\n";
      const once = applySnippet(user, d.section!.spec, d.section!.body, true).text;
      expect(findOwnedSections(once, d.section!.spec)).toHaveLength(1);
      const twice = applySnippet(once, d.section!.spec, d.section!.body, true);
      expect(twice.unchanged).toBe(true);
      expect(twice.text).toBe(once);
      expect(once).toContain("## Their Own Section");
      expect(once).not.toMatch(/\n{3,}/);
    }
  });
});

describe("stampDoctrine", () => {
  const FILE = "/repo/AGENTS.md";

  test("stamps into an existing AGENTS.md and preserves the repo's prose", () => {
    const fsi = memoryFs({ [FILE]: "# myapp\n\n## Conventions\nno build step\n" });
    const report = stampDoctrine({ filePath: FILE, fs: fsi });
    expect(report.unchanged).toBe(false);
    const out = fsi.files.get(FILE)!;
    expect(out).toContain("## Conventions");
    expect(out).toContain("no build step");
    expect(out).toContain("## Local-first store");
    expect(out).toContain(LOCAL_FIRST_STORE.section!.spec.endMarker);
  });

  test("a re-stamp with unchanged doctrine writes nothing", () => {
    const fsi = memoryFs({ [FILE]: "# myapp\n" });
    stampDoctrine({ filePath: FILE, fs: fsi });
    const again = stampDoctrine({ filePath: FILE, fs: fsi });
    expect(again.unchanged).toBe(true);
    expect(fsi.writes.get(FILE)).toBe(1);
  });

  test("a revised doctrine body refreshes the section in place", () => {
    const fsi = memoryFs({ [FILE]: "# myapp\n\n## Above\nmine\n" });
    stampDoctrine({ filePath: FILE, fs: fsi });
    const revised = {
      ...LOCAL_FIRST_STORE,
      section: {
        spec: LOCAL_FIRST_STORE.section!.spec,
        body: LOCAL_FIRST_STORE.section!.body.replace(
          "Local-first is the law.",
          "Local-first is the law, revised.",
        ),
      },
    };
    stampDoctrine({ filePath: FILE, sections: [revised], fs: fsi });
    const out = fsi.files.get(FILE)!;
    expect(out).toContain("revised");
    expect(out.match(/## Local-first store/g)).toHaveLength(1);
    expect(out.indexOf("## Above")).toBeLessThan(out.indexOf("## Local-first store"));
  });

  test("stamps a repo that has no AGENTS.md yet", () => {
    const fsi = memoryFs();
    fsi.mkdir("/repo");
    stampDoctrine({ filePath: FILE, fs: fsi });
    expect(fsi.files.get(FILE)).toContain("## Local-first store");
  });
});
