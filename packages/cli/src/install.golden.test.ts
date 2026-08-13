/**
 * Byte-for-byte golden of what `cast install <slug>` writes, for every slug in
 * SNIPPET_CATALOG.
 *
 * This is a characterization test, not a specification. It pins what the snippet
 * writers produced BEFORE the phase-0 rewrite, so that rewrite can prove it
 * changed nothing a user sees. Nothing here claims the recorded output is
 * correct — only that it is unchanged. A failure is a report, not a verdict:
 * read the diff, decide whether the change was intended, and re-baseline
 * deliberately (see below) rather than reflexively.
 *
 * Provenance of the fixtures — which commit they were recorded from and why one
 * slug differs — is written down in __fixtures__/install-golden/BASELINE.md.
 * Read it before concluding anything from a failure.
 *
 * Two scenarios per slug, because the writers take two different code paths:
 *   fresh/    — no CLAUDE.md at all; the section lands in an empty file.
 *   existing/ — __fixtures__/install-golden/seed.md, which already carries two
 *               codecast blocks (## Messaging and ## Referencing objects) with
 *               user prose above, between, and below them. That covers the
 *               append path for the other slugs, the replace path for
 *               `messaging` and for every slug that refreshes the shared
 *               references block, and proves the surrounding user text survives.
 *
 * The slug → config-key mapping is recorded in manifest.json for the same
 * reason the catalog centralizes it: it is historical and non-guessable
 * (`tasks` writes work_enabled, `triggers` writes task_enabled). A silent remap
 * would disable the wrong feature on every machine that upgrades and would
 * leave no trace in a diff of the snippet bodies.
 *
 * The CLI is driven as a subprocess rather than by importing the writers,
 * because index.ts calls `program.parse()` at module scope and cannot be
 * imported. It runs `src/index.ts`, never `dist/` — a stale dist would golden
 * yesterday's output.
 *
 * NORMALIZATION — everything that is not stable between two identical runs, and
 * nothing else. An unstable golden is worse than none:
 *   1. config.json `created_at` / `updated_at` are dropped (wall clock).
 *   2. The scratch HOME path is replaced with @HOME@ inside the side files
 *      before hashing (mkdtemp gives a fresh path each run).
 *   3. A slug that writes no CLAUDE.md at all — `orchestration` writes skills,
 *      agents, and hooks instead — goldens the sentinel @ABSENT@ rather than a
 *      missing file, so "wrote nothing" is asserted rather than skipped.
 * The snippet bodies carry no version number or timestamp of their own: the
 * version lives only in config.json, and manifest.json records its exact value,
 * so a body edit that forgets its version bump shows as a one-sided diff.
 *
 * RE-RECORDING (all three env knobs exist for this, and only this):
 *   UPDATE_GOLDEN=1      write the fixtures instead of comparing them
 *   GOLDEN_CLI_ROOT=…    record from another checkout's packages/cli (this is
 *                        how the pre-rewrite baseline was taken from a
 *                        `git archive HEAD` extraction — the working tree had
 *                        already moved on)
 *   GOLDEN_SLUGS=a,b     restrict the run to these slugs; manifest.json is then
 *                        merged rather than rewritten, so a baseline assembled
 *                        from two checkouts does not lose half its entries
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SNIPPET_CATALOG } from "@codecast/shared/contracts";

const cliRoot = process.env.GOLDEN_CLI_ROOT ?? path.join(import.meta.dir, "..");
const cliEntry = path.join(cliRoot, "src", "index.ts");
const goldenDir = path.join(import.meta.dir, "__fixtures__", "install-golden");
const seedPath = path.join(goldenDir, "seed.md");

const UPDATE = process.env.UPDATE_GOLDEN === "1";
const only = process.env.GOLDEN_SLUGS?.split(",").map((s) => s.trim()).filter(Boolean);
const slugs = SNIPPET_CATALOG.filter((d) => !only || only.includes(d.slug));

/** A slug that writes no CLAUDE.md section goldens this instead of a missing file. */
const ABSENT = "@ABSENT@\n";

const scratchHomes: string[] = [];

function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-install-golden-"));
  scratchHomes.push(home);
  // A fresh update-state stops the CLI reaching for dl.codecast.sh on startup,
  // which would put the network in the middle of a byte comparison. Same dodge
  // as stableContext.cli.test.ts:19.
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codecast", "update-state.json"),
    JSON.stringify({ lastCheck: new Date().toISOString() }),
  );
  return home;
}

afterEach(() => {
  for (const home of scratchHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

interface InstallRun {
  stdout: string;
  claudeMd: string;
  /** config.json as written, minus the two wall-clock fields. */
  config: Record<string, unknown>;
  /** Everything else the install put on disk: relative path → content hash. */
  files: Record<string, string>;
}

/**
 * Run `cast install <slug>` against a scratch HOME and collect everything a user
 * could see afterwards.
 *
 * `seed` is the CLAUDE.md the install lands on; omit it for the fresh case. Only
 * ~/.claude and ~/.codecast are inspected — bun writes its own cache under a
 * scratch HOME, and that is not part of the install.
 */
function runInstall(slug: string, seed?: string): InstallRun {
  const home = scratchHome();
  const claudePath = path.join(home, ".claude", "CLAUDE.md");
  if (seed !== undefined) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(claudePath, seed);
  }

  const proc = spawnSync(process.execPath, [cliEntry, "install", slug], {
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (proc.status !== 0) {
    throw new Error(`cast install ${slug} exited ${proc.status}: ${proc.stderr}`);
  }

  const rawConfig = JSON.parse(
    fs.readFileSync(path.join(home, ".codecast", "config.json"), "utf8"),
  ) as Record<string, unknown>;
  delete rawConfig.created_at;
  delete rawConfig.updated_at;

  const files: Record<string, string> = {};
  for (const dir of [".claude", ".codecast"]) {
    const root = path.join(home, dir);
    if (!fs.existsSync(root)) continue;
    for (const abs of walk(root)) {
      const rel = path.relative(home, abs);
      // Recorded elsewhere (config, CLAUDE.md) or scaffolding this harness wrote.
      if (rel === path.join(".codecast", "config.json")) continue;
      if (rel === path.join(".codecast", "update-state.json")) continue;
      if (rel === path.join(".claude", "CLAUDE.md")) continue;
      const body = fs.readFileSync(abs, "utf8").split(home).join("@HOME@");
      files[rel] = createHash("sha256").update(body).digest("hex").slice(0, 16);
    }
  }

  return {
    stdout: proc.stdout,
    claudeMd: fs.existsSync(claudePath) ? fs.readFileSync(claudePath, "utf8") : ABSENT,
    config: rawConfig,
    files,
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out.sort();
}

/**
 * Compare against the checked-in fixture, or record it under UPDATE_GOLDEN.
 *
 * The failure names the fixture and the first line that moved. A raw string
 * `expect` on a 4000-character markdown section reports as one unreadable blob,
 * which is how a golden test stops being read and starts being re-baselined.
 */
function expectGolden(relPath: string, actual: string): void {
  const file = path.join(goldenDir, relPath);
  if (UPDATE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  if (!fs.existsSync(file)) {
    throw new Error(
      `no baseline for ${relPath}. This slug post-dates the recorded baseline — ` +
      `see __fixtures__/install-golden/BASELINE.md, then record it deliberately.`,
    );
  }
  const expected = fs.readFileSync(file, "utf8");
  if (actual === expected) return;

  const a = expected.split("\n");
  const b = actual.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  throw new Error(
    `${relPath} no longer matches the recorded baseline.\n` +
    `  first divergence at line ${i + 1} (${a.length} baseline lines vs ${b.length} now)\n` +
    `  baseline: ${JSON.stringify(a[i] ?? "<end of file>")}\n` +
    `  now:      ${JSON.stringify(b[i] ?? "<end of file>")}\n` +
    `Read BASELINE.md before re-recording.`,
  );
}

const seed = fs.readFileSync(seedPath, "utf8");
const manifest: Record<string, unknown> = {};

describe("cast install — golden output per catalog slug", () => {
  for (const descriptor of slugs) {
    const slug = descriptor.slug;

    test(`${slug} — into a fresh HOME and onto the seeded CLAUDE.md`, () => {
      const fresh = runInstall(slug);
      const existing = runInstall(slug, seed);

      // The config assertions come first: a remapped config key is a worse
      // regression than a reworded paragraph, and it should be the failure a
      // reader sees rather than being buried under a markdown diff.
      expect(fresh.config[descriptor.enabledKey]).toBe(true);
      expect(typeof fresh.config[descriptor.versionKey]).toBe("string");
      // Exactly these two keys: an install that also flips a neighbour's flag
      // is the silent remap this fixture exists to catch.
      expect(Object.keys(fresh.config).sort()).toEqual(
        [descriptor.enabledKey, descriptor.versionKey].sort(),
      );

      manifest[slug] = {
        enabledKey: descriptor.enabledKey,
        versionKey: descriptor.versionKey,
        version: fresh.config[descriptor.versionKey],
        stdout: fresh.stdout,
        wroteClaudeMd: fresh.claudeMd !== ABSENT,
        otherFiles: fresh.files,
      };

      expectGolden(path.join("fresh", `${slug}.md`), fresh.claudeMd);
      expectGolden(path.join("existing", `${slug}.md`), existing.claudeMd);
    }, 60_000);
  }

  // Runs last: bun executes tests in declaration order, so every slug has filed
  // its entry by now. Keeping the mapping in ONE file makes the historical
  // slug → key table readable in a single diff instead of scattered across
  // twenty-odd markdown fixtures.
  test("the slug → config key mapping is unchanged", () => {
    const file = path.join(goldenDir, "manifest.json");
    if (UPDATE) {
      // Merge, so a baseline recorded slug-by-slug from two checkouts keeps the
      // entries an earlier pass wrote.
      const prior = fs.existsSync(file)
        ? (JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>)
        : {};
      const merged = only ? { ...prior, ...manifest } : manifest;
      // Catalog order, not merge order, so the file reads like the catalog.
      const ordered: Record<string, unknown> = {};
      for (const d of SNIPPET_CATALOG) if (merged[d.slug]) ordered[d.slug] = merged[d.slug];
      fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + "\n");
      return;
    }
    const recorded = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const slug of Object.keys(manifest)) {
      expect(`${slug}: ${JSON.stringify(manifest[slug])}`).toBe(
        `${slug}: ${JSON.stringify(recorded[slug])}`,
      );
    }
  });

  test("no fixture carries the CLI package version", () => {
    // The one thing that would make this golden churn on every release. If a
    // snippet body ever interpolates the version, catch it here rather than
    // discovering it as a mystery failure the day after a version bump.
    const pkgVersion = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"),
    ).version as string;
    for (const dir of ["fresh", "existing"]) {
      const abs = path.join(goldenDir, dir);
      if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs)) {
        const body = fs.readFileSync(path.join(abs, name), "utf8");
        expect(`${dir}/${name} contains ${pkgVersion}: ${body.includes(pkgVersion)}`)
          .toBe(`${dir}/${name} contains ${pkgVersion}: false`);
      }
    }
  });
});

describe("cast install — a heading match is a prefix match", () => {
  /**
   * A sharp edge of the writers, recorded so a rewrite cannot round it off by
   * accident. Sections are located with `indexOf("## Memory")`, so a user's own
   * `## Memory notes` heading matches too. Such a block survives only because it
   * carries neither our end marker nor a content probe — put the phrase
   * `cast search` under that heading and the writer treats the section as ours
   * and cuts it. These assert TODAY's behavior; neither is a claim that it is
   * right.
   */
  test("a user heading that merely starts with ours is left alone", () => {
    const userFile = [
      "# Notes",
      "",
      "## Memory notes",
      "",
      "My own reminders. No codecast marker, no probe phrase.",
      "",
    ].join("\n");
    const out = runInstall("memory", userFile).claudeMd;
    expect(out.startsWith(userFile)).toBe(true);
    expect(out).toContain("My own reminders.");
  }, 60_000);

  test("…but the same heading is cut once its body contains a content probe", () => {
    const userFile = [
      "# Notes",
      "",
      "## Memory notes",
      "",
      "Remember to run cast search before starting anything.",
      "",
      "## Keep me",
      "",
      "This section must survive.",
      "",
    ].join("\n");
    const out = runInstall("memory", userFile).claudeMd;
    expect(out).not.toContain("Remember to run cast search before starting");
    expect(out).toContain("## Keep me");
    expect(out).toContain("This section must survive.");
  }, 60_000);
});
