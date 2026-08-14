/**
 * ct-42806: rewrites are keyed on a CONTENT HASH of the body a binary ships,
 * not on the hand-bumped version constants in update.ts. The constants were
 * wrong in both directions — a body edit with no bump never reinstalled, and a
 * bump with identical bytes rewrote every instruction file on every upgrade,
 * fleet-wide under a reconciler. The version keys stay in config as a display
 * value and a downgrade shadow (an older CLI compares its own constant against
 * them), written alongside the hash by stampSnippet.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SNIPPET_CATALOG, snippetContentHash } from "@codecast/shared/contracts";
import { installSectionToFile, snippetStale, stampSnippet } from "./snippets.js";

const memory = SNIPPET_CATALOG.find((s) => s.slug === "memory")!;
const section = memory.section!;

describe("snippetStale / stampSnippet", () => {
  test("a config with no hash recorded is stale", () => {
    // Every machine upgrading from the version-keyed CLI takes this path once;
    // the byte-compare in installSectionToFile turns the pass into zero writes.
    expect(snippetStale({}, "memory")).toBe(true);
    expect(snippetStale(undefined, "memory")).toBe(true);
    expect(snippetStale(null, "memory")).toBe(true);
  });

  test("stamping records the hash and the version shadow", () => {
    const config: Record<string, unknown> = {};
    expect(stampSnippet(config, "memory", "12")).toBe(true);
    expect(config.memory_version).toBe("12");
    expect(config.memory_hash).toBe(snippetContentHash(section.body));
    expect(snippetStale(config, "memory")).toBe(false);
  });

  test("bumping the version with an unchanged body does not make it stale", () => {
    const config: Record<string, unknown> = {};
    stampSnippet(config, "memory", "12");
    // The next binary ships version "13" and the same bytes: the rewrite
    // decision reads only the hash…
    expect(snippetStale(config, "memory")).toBe(false);
    // …and re-stamping refreshes only the shadow.
    expect(stampSnippet(config, "memory", "13")).toBe(true);
    expect(config.memory_version).toBe("13");
    expect(config.memory_hash).toBe(snippetContentHash(section.body));
    expect(stampSnippet(config, "memory", "13")).toBe(false); // now a no-op
  });

  test("a body edit flips it stale with no version bump anywhere", () => {
    const config: Record<string, unknown> = {
      memory_version: "12",
      // The hash of yesterday's body — one character of drift is enough.
      memory_hash: snippetContentHash(section.body + "edited"),
    };
    expect(snippetStale(config, "memory")).toBe(true);
  });

  test("a slug without a markdown section is never stale and stamps only its version", () => {
    expect(snippetStale({}, "orchestration")).toBe(false);
    const config: Record<string, unknown> = {};
    stampSnippet(config, "orchestration", "7");
    expect(config.orch_version).toBe("7");
    expect(config.orch_hash).toBeUndefined();
  });

  test("the historical slug → config key mapping holds", () => {
    // The mapping is deliberately not guessable: tasks writes work_*, triggers
    // writes task_*. The helpers read it from the catalog, never re-derive it.
    const config: Record<string, unknown> = {};
    stampSnippet(config, "tasks", "7");
    expect(config.work_version).toBe("7");
    expect(typeof config.work_hash).toBe("string");
    stampSnippet(config, "triggers", "5");
    expect(config.task_version).toBe("5");
    expect(typeof config.task_hash).toBe("string");
  });
});

// The claims above, proved against real files: mtime is the observable that
// matters — it is what every watcher on CLAUDE.md wakes on.
describe("the upgrade path over real files", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cast-rewrite-key-"));
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  /** One machine mid-life: section installed, config stamped, mtime parked in
   *  the past so any rewrite is unmistakable. */
  const seeded = (name: string) => {
    const dir = path.join(tmpRoot, name);
    const file = path.join(dir, "CLAUDE.md");
    installSectionToFile(file, dir, section.spec, section.body, true);
    const config: Record<string, unknown> = {};
    stampSnippet(config, "memory", "12");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    return { file, dir, config, mtime: fs.statSync(file).mtimeMs };
  };

  /** The refresh gate as index.ts runs it: reinstall only when stale. */
  const refresh = (config: Record<string, unknown>, file: string, dir: string, version: string) => {
    if (snippetStale(config, "memory")) {
      installSectionToFile(file, dir, section.spec, section.body, true);
    }
    stampSnippet(config, "memory", version);
  };

  test("a simulated version bump with unchanged bytes touches no file's mtime", () => {
    const { file, dir, config, mtime } = seeded("version-bump");
    refresh(config, file, dir, "13"); // the upgraded binary: new constant, same body
    expect(fs.statSync(file).mtimeMs).toBe(mtime); // zero writes
    expect(config.memory_version).toBe("13"); // shadow is current anyway
  });

  test("a body edit with an unchanged version produces exactly one write", () => {
    const { file, dir, config, mtime } = seeded("body-edit");
    const edited = section.body.replace(
      section.spec.endMarker,
      `One more paragraph.\n${section.spec.endMarker}`,
    );
    // What the gate compares: the recorded hash against the hash of what the
    // new binary ships. The edit flips it with no version bump anywhere.
    expect(config.memory_hash).not.toBe(snippetContentHash(edited));
    installSectionToFile(file, dir, section.spec, edited, true);
    const afterFirst = fs.statSync(file).mtimeMs;
    expect(afterFirst).toBeGreaterThan(mtime); // the one write…
    config.memory_hash = snippetContentHash(edited); // …then stamped
    installSectionToFile(file, dir, section.spec, edited, true);
    expect(fs.statSync(file).mtimeMs).toBe(afterFirst); // …and never a second
  });

  test("ten reconcile passes with current bytes never move the mtime", () => {
    const { file, dir, config, mtime } = seeded("reconcile");
    for (let i = 0; i < 10; i++) refresh(config, file, dir, "12");
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  test("an upgrade from a version-keyed config self-heals without a rewrite", () => {
    const { file, dir, mtime } = seeded("legacy-config");
    // A config written by the old CLI: version present, no hash.
    const config: Record<string, unknown> = { memory_version: "12" };
    expect(snippetStale(config, "memory")).toBe(true); // one reinstall pass…
    refresh(config, file, dir, "12");
    expect(fs.statSync(file).mtimeMs).toBe(mtime); // …that writes nothing
    expect(snippetStale(config, "memory")).toBe(false); // and heals the config
  });
});
