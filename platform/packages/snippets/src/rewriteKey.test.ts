// Ported from codecast packages/cli/src/snippets.rewriteKey.test.ts.
//
// Rewrites are keyed on a CONTENT HASH of the body a binary ships, not on
// hand-bumped version constants. The constants were wrong in both directions:
// a body edit with no bump never reinstalled, and a bump with identical bytes
// rewrote every instruction file on every upgrade, fleet wide under a
// reconciler. The version keys stay in config as a display value and a shadow
// for older binaries, written alongside the hash by stampSnippet.
//
// The donor keyed these tests off its catalog's memory snippet; here a local
// definition stands in, and the file half runs on the injected in-memory
// filesystem with write counts standing in for the mtime.

import { describe, expect, test } from "bun:test";
import { snippetContentHash } from "./hash";
import { snippetHashKey, snippetStale, stampSnippet } from "./rewriteKey";
import { installSectionToFile } from "./install";
import { memoryFs, type MemoryFs } from "./fs";
import type { SnippetDefinition } from "./types";

const END = "<!-- /platform-memory -->";
const BODY = `\n## Memory\n\nsearch prior sessions with cast search\n${END}\n`;
const memory: SnippetDefinition = {
  slug: "memory",
  name: "Memory",
  desc: "recall",
  detail: "recall across sessions",
  writesTo: "CLAUDE.md",
  shipped: "2026-06-18",
  enabledKey: "memory_enabled",
  versionKey: "memory_version",
  section: { spec: { headings: ["## Memory"], endMarker: END }, body: BODY },
};
const section = memory.section!;

// The historical slug to config key mapping is not guessable (the donor's
// "tasks" snippet writes work_*, its "triggers" snippet writes task_*). The
// helpers read whatever keys the definition names, never re-derive them.
const tasks: SnippetDefinition = { ...memory, slug: "tasks", enabledKey: "work_enabled", versionKey: "work_version" };

// No markdown at all — the donor's orchestration snippet installs skills,
// agents and hooks instead.
const orchestration: SnippetDefinition = {
  ...memory,
  slug: "orchestration",
  enabledKey: "orch_enabled",
  versionKey: "orch_version",
  section: undefined,
};

describe("snippetStale / stampSnippet", () => {
  test("a config with no hash recorded is stale", () => {
    // Every machine upgrading from a version-keyed config takes this path
    // once; the byte compare in the file writer turns the pass into zero
    // writes.
    expect(snippetStale({}, memory)).toBe(true);
    expect(snippetStale(undefined, memory)).toBe(true);
    expect(snippetStale(null, memory)).toBe(true);
  });

  test("stamping records the hash and the version shadow", () => {
    const config: Record<string, unknown> = {};
    expect(stampSnippet(config, memory, "12")).toBe(true);
    expect(config.memory_version).toBe("12");
    expect(config.memory_hash).toBe(snippetContentHash(section.body));
    expect(snippetStale(config, memory)).toBe(false);
  });

  test("bumping the version with an unchanged body does not make it stale", () => {
    const config: Record<string, unknown> = {};
    stampSnippet(config, memory, "12");
    // The next binary ships version "13" and the same bytes: the rewrite
    // decision reads only the hash…
    expect(snippetStale(config, memory)).toBe(false);
    // …and re-stamping refreshes only the shadow.
    expect(stampSnippet(config, memory, "13")).toBe(true);
    expect(config.memory_version).toBe("13");
    expect(config.memory_hash).toBe(snippetContentHash(section.body));
    expect(stampSnippet(config, memory, "13")).toBe(false); // now a no-op
  });

  test("a body edit flips it stale with no version bump anywhere", () => {
    const config: Record<string, unknown> = {
      memory_version: "12",
      // The hash of yesterday's body — one character of drift is enough.
      memory_hash: snippetContentHash(section.body + "edited"),
    };
    expect(snippetStale(config, memory)).toBe(true);
  });

  test("a definition without a markdown section is never stale and stamps only its version", () => {
    expect(snippetStale({}, orchestration)).toBe(false);
    const config: Record<string, unknown> = {};
    stampSnippet(config, orchestration, "7");
    expect(config.orch_version).toBe("7");
    expect(config.orch_hash).toBeUndefined();
  });

  test("the config keys come from the definition, never from the slug", () => {
    const config: Record<string, unknown> = {};
    stampSnippet(config, tasks, "7");
    expect(config.work_version).toBe("7");
    expect(typeof config.work_hash).toBe("string");
    expect(config.tasks_version).toBeUndefined();
  });

  test("an explicit hashKey wins over the derivation", () => {
    const custom: SnippetDefinition = { ...memory, hashKey: "memory_digest" };
    const config: Record<string, unknown> = {};
    stampSnippet(config, custom, "1");
    expect(config.memory_digest).toBe(snippetContentHash(section.body));
    expect(snippetStale(config, custom)).toBe(false);
  });

  test("a versionKey that cannot derive a hash key throws instead of colliding", () => {
    const bad: SnippetDefinition = { ...memory, versionKey: "memory_ver" };
    // Colliding the hash and the version into one config key would make
    // snippetStale read true on every run and rewrite that snippet forever.
    expect(() => snippetHashKey(bad)).toThrow(/does not end in _version/);
    expect(() => snippetStale({}, bad)).toThrow(/does not end in _version/);
  });
});

// The claims above over files: the write count is the observable that in the
// donor was the mtime — what every watcher on CLAUDE.md wakes on.
describe("the upgrade path over files", () => {
  const FILE = "/home/.claude/CLAUDE.md";

  /** One machine mid-life: section installed, config stamped. */
  const seeded = (): { fsi: MemoryFs; config: Record<string, unknown> } => {
    const fsi = memoryFs();
    installSectionToFile(fsi, { filePath: FILE }, section.spec, section.body, true);
    const config: Record<string, unknown> = {};
    stampSnippet(config, memory, "12");
    return { fsi, config };
  };

  /** The refresh gate as a CLI runs it: reinstall only when stale. */
  const refresh = (fsi: MemoryFs, config: Record<string, unknown>, version: string) => {
    if (snippetStale(config, memory)) {
      installSectionToFile(fsi, { filePath: FILE }, section.spec, section.body, true);
    }
    stampSnippet(config, memory, version);
  };

  test("a simulated version bump with unchanged bytes writes no file", () => {
    const { fsi, config } = seeded();
    refresh(fsi, config, "13"); // the upgraded binary: new constant, same body
    expect(fsi.writes.get(FILE)).toBe(1); // zero further writes
    expect(config.memory_version).toBe("13"); // shadow is current anyway
  });

  test("a body edit with an unchanged version produces exactly one write", () => {
    const { fsi, config } = seeded();
    const edited = section.body.replace(END, `One more paragraph.\n${END}`);
    // What the gate compares: the recorded hash against the hash of what the
    // new binary ships. The edit flips it with no version bump anywhere.
    expect(config.memory_hash).not.toBe(snippetContentHash(edited));
    installSectionToFile(fsi, { filePath: FILE }, section.spec, edited, true);
    expect(fsi.writes.get(FILE)).toBe(2); // the one write…
    config.memory_hash = snippetContentHash(edited); // …then stamped
    installSectionToFile(fsi, { filePath: FILE }, section.spec, edited, true);
    expect(fsi.writes.get(FILE)).toBe(2); // …and never a second
  });

  test("ten reconcile passes with current bytes never write again", () => {
    const { fsi, config } = seeded();
    for (let i = 0; i < 10; i++) refresh(fsi, config, "12");
    expect(fsi.writes.get(FILE)).toBe(1);
  });

  test("an upgrade from a version-keyed config self-heals without a rewrite", () => {
    const { fsi } = seeded();
    // A config written by the old binary: version present, no hash.
    const config: Record<string, unknown> = { memory_version: "12" };
    expect(snippetStale(config, memory)).toBe(true); // one reinstall pass…
    refresh(fsi, config, "12");
    expect(fsi.writes.get(FILE)).toBe(1); // …that writes nothing
    expect(snippetStale(config, memory)).toBe(false); // and heals the config
  });
});
