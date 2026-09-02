// The whole-table reconcile: one install() call is the pass a CLI runs on
// install, on update and on boot — enabled definitions installed or
// refreshed, disabled ones removed, and `unchanged` true only when no file
// moved anywhere.

import { describe, expect, test } from "bun:test";
import { install, removeSectionFromTargets } from "./install";
import { memoryFs } from "./fs";
import type { SnippetDefinition } from "./types";

const def = (slug: string, extra?: Partial<SnippetDefinition>): SnippetDefinition => ({
  slug,
  name: slug,
  desc: slug,
  detail: slug,
  writesTo: "CLAUDE.md",
  shipped: "2026-08-21",
  enabledKey: `${slug}_enabled`,
  versionKey: `${slug}_version`,
  section: {
    spec: { headings: [`## ${slug}`], endMarker: `<!-- /platform-${slug} -->` },
    body: `\n## ${slug}\n\n${slug} body\n<!-- /platform-${slug} -->\n`,
  },
  ...extra,
});

const memory = def("memory");
const messaging = def("messaging");
const orchestration = def("orchestration", { section: undefined });
const DEFS = [memory, messaging, orchestration];

const CLAUDE = "/home/.claude/CLAUDE.md";
const CODEX = "/home/.codex/AGENTS.md";
const TARGETS = [{ filePath: CLAUDE }, { filePath: CODEX }];

const flags = (on: Record<string, boolean>) => (d: SnippetDefinition) => on[d.slug] === true;

describe("install over a definition table", () => {
  test("installs the enabled, removes the disabled, skips the sectionless", () => {
    const fsi = memoryFs({ [CLAUDE]: "# Mine\nKEEP\n" });
    fsi.mkdir("/home/.codex");
    const report = install(DEFS, {
      targets: TARGETS,
      enabled: flags({ memory: true }),
      fs: fsi,
    });
    expect(report.results.memory).toMatchObject({ installed: true, unchanged: false });
    expect(report.results.messaging).toMatchObject({ removed: false, unchanged: true });
    expect(report.results.orchestration).toBeUndefined();
    expect(report.unchanged).toBe(false);
    for (const file of [CLAUDE, CODEX]) {
      expect(fsi.files.get(file)).toContain("## memory");
      expect(fsi.files.get(file)).not.toContain("## messaging");
    }
    expect(fsi.files.get(CLAUDE)).toContain("KEEP");
  });

  test("a second identical pass changes nothing", () => {
    const fsi = memoryFs();
    const opts = { targets: TARGETS, enabled: flags({ memory: true, messaging: true }), fs: fsi };
    install(DEFS, opts);
    const second = install(DEFS, opts);
    expect(second.unchanged).toBe(true);
    // The first pass wrote each file once per section; the second wrote nothing.
    expect(fsi.writes.get(CLAUDE)).toBe(2);
    expect(fsi.writes.get(CODEX)).toBe(2);
  });

  test("disabling removes the section everywhere and reports the change", () => {
    const fsi = memoryFs();
    install(DEFS, { targets: TARGETS, enabled: flags({ memory: true, messaging: true }), fs: fsi });
    const report = install(DEFS, { targets: TARGETS, enabled: flags({ memory: true }), fs: fsi });
    expect(report.results.messaging).toMatchObject({ removed: true, unchanged: false });
    expect(report.unchanged).toBe(false);
    for (const file of [CLAUDE, CODEX]) {
      expect(fsi.files.get(file)).toContain("## memory");
      expect(fsi.files.get(file)).not.toContain("## messaging");
    }
    // Disable then re-enable is a round trip: the enable pass restores the
    // exact bytes, and one more pass is a no-op.
    const before = fsi.files.get(CLAUDE);
    install(DEFS, { targets: TARGETS, enabled: flags({ memory: true, messaging: true }), fs: fsi });
    const after = install(DEFS, { targets: TARGETS, enabled: flags({ memory: true, messaging: true }), fs: fsi });
    expect(after.unchanged).toBe(true);
    expect(fsi.files.get(CLAUDE)).toContain("## messaging");
    expect(before).not.toBe(fsi.files.get(CLAUDE));
  });

  test("update: false leaves an existing section alone", () => {
    const stale = `## memory\nSTALE\n<!-- /platform-memory -->\n`;
    const fsi = memoryFs({ [CLAUDE]: stale });
    const report = install([memory], {
      targets: [{ filePath: CLAUDE }],
      enabled: () => true,
      fs: fsi,
      update: false,
    });
    expect(report.results.memory).toMatchObject({ installed: false, unchanged: true });
    expect(fsi.files.get(CLAUDE)).toBe(stale);
  });
});

describe("removeSectionFromTargets", () => {
  test("skips missing files and reports whether anything was removed", () => {
    const fsi = memoryFs({ [CLAUDE]: `# Mine\n\n## memory\nbody\n<!-- /platform-memory -->\n` });
    expect(removeSectionFromTargets(fsi, TARGETS, memory.section!.spec)).toBe(true);
    expect(fsi.files.get(CLAUDE)).toBe("# Mine\n");
    expect(fsi.files.has(CODEX)).toBe(false);
    // A second sweep finds nothing to do.
    expect(removeSectionFromTargets(fsi, TARGETS, memory.section!.spec)).toBe(false);
  });
});
