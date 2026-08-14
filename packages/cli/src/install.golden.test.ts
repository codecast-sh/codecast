/**
 * Byte-for-byte golden of what `cast install <slug>` writes, for every slug in
 * SNIPPET_CATALOG.
 *
 * This is a characterization test, not a specification. It pins what the
 * snippet writers produce, so a change to them has to be argued for in a diff
 * instead of arriving unnoticed. Nothing here claims the recorded output is
 * correct — only that it is unchanged. A failure is a report, not a verdict:
 * read the diff, decide whether the change was intended, and re-record
 * deliberately rather than reflexively.
 *
 * Two eras of fixtures are checked in. `fresh/` and `existing/` hold what the
 * CLI writes today and are what the tests compare against. `pre-rewrite/` holds
 * the pre-phase-0 bytes for the files the rewrite moved, kept so the two can
 * still be diffed. Which commit each came from, and what moved between them, is
 * in __fixtures__/install-golden/BASELINE.md. Read it before concluding
 * anything from a failure.
 *
 * Three scenarios per slug, because the writers take three different paths:
 *   fresh/    — no CLAUDE.md at all; the section lands in an empty file.
 *   existing/ — __fixtures__/install-golden/seed.md, which already carries two
 *               codecast blocks (## Messaging and ## Referencing objects) with
 *               user prose above, between, and below them. That covers the
 *               append path for the other slugs, the replace path for
 *               `messaging` and for every slug that refreshes the shared
 *               references block, and proves the surrounding user text survives.
 *   settled   — the seeded install run a SECOND time, over bytes this writer
 *               itself just produced. It has no fixture of its own: the whole
 *               assertion is that it reproduces the first run exactly. This is
 *               the path every upgrade takes, and the one the shipped CLI got
 *               wrong (see snippets.ts:104 — it stacked one extra blank line per
 *               snippet per run, so a CLAUDE.md grew forever).
 *
 * `help.txt` holds `cast install -h`, the one screen where a user reads the slug
 * list. It is recorded once, not per slug.
 *
 * Two guards deliberately do NOT read a fixture, so that re-recording cannot
 * launder a regression into the new baseline: the settled-run comparison above,
 * and the check that every user line of seed.md survives the install. Both run
 * under UPDATE_GOLDEN as well.
 *
 * The slug → config-key mapping is recorded in manifest.json for the same
 * reason the catalog centralizes it: it is historical and non-guessable
 * (`tasks` writes work_enabled, `triggers` writes task_enabled). A silent remap
 * would disable the wrong feature on every machine that upgrades and would
 * leave no trace in a diff of the snippet bodies. The manifest records the
 * config object the CLI actually wrote — keys and values observed on disk, not
 * copied back out of the descriptor that is under test.
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
 *                        how pre-rewrite/ was taken, from a `git archive`
 *                        extraction of the baseline commit — the working tree
 *                        had already moved on)
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
const preRewriteDir = path.join(goldenDir, "pre-rewrite");
const seedPath = path.join(goldenDir, "seed.md");

const UPDATE = process.env.UPDATE_GOLDEN === "1";
const only = process.env.GOLDEN_SLUGS?.split(",").map((s) => s.trim()).filter(Boolean);
const slugs = SNIPPET_CATALOG.filter((d) => !only || only.includes(d.slug));

/** A slug that writes no CLAUDE.md section goldens this instead of a missing file. */
const ABSENT = "@ABSENT@\n";

/**
 * Slugs whose body changed in the phase-0 rewrite while their version number
 * stayed where it was. This is a live bug, not a licence: an installed machine
 * refreshes a snippet only when its recorded version differs from the CLI's
 * (index.ts:2832), so an unbumped body never reaches a user who already has the
 * old one — they keep yesterday's text forever.
 *
 * Bump the version in update.ts, re-record, and delete the slug from this list.
 */
const BODY_CHANGED_WITHOUT_VERSION_BUMP = ["memory"];

/**
 * Slugs whose success line tells the user it wrote ~/.claude/CLAUDE.md when the
 * install wrote no CLAUDE.md at all. `orchestration` installs skills, agents and
 * hooks; the line comes from the CLAUDE.md target list regardless of what the
 * snippet actually touches (index.ts:9601).
 *
 * Also a record of a live bug, not permission for it.
 */
const STDOUT_NAMES_A_FILE_IT_DID_NOT_WRITE = ["orchestration"];

const scratchHomes: string[] = [];

// Duplicated from stableContext.cli.test.ts:18. The extraction belongs in
// src/test-helpers/scratchHome.ts alongside the other shared harnesses, and is
// filed as a handoff on ct-42800 — landing it here alone would leave the copy
// in that file behind, and that file is owned by another session.
function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-install-golden-"));
  scratchHomes.push(home);
  // A fresh update-state stops the CLI reaching for dl.codecast.sh on startup,
  // which would put the network in the middle of a byte comparison.
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

/** One `cast …` run against a scratch HOME. Throws on any non-zero exit. */
function runCli(home: string, args: string[], attempt = ""): string {
  const proc = spawnSync(process.execPath, [cliEntry, ...args], {
    env: { ...process.env, HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  if (proc.status !== 0) {
    throw new Error(
      `cast ${args.join(" ")} exited ${proc.status}${attempt}.\n` +
      `  cli: ${cliEntry}\n` +
      `  stdout: ${proc.stdout}\n` +
      `  stderr: ${proc.stderr}`,
    );
  }
  return proc.stdout;
}

/**
 * Run `cast install <slug>` against a scratch HOME and collect everything a user
 * could see afterwards.
 *
 * `seed` is the CLAUDE.md the install lands on; omit it for the fresh case.
 * `runs` above 1 repeats the command in the SAME HOME and reports the final
 * state — that is the upgrade path, where the writer reads bytes it wrote
 * itself. Only ~/.claude and ~/.codecast are inspected: bun writes its own
 * cache under a scratch HOME, and that is not part of the install.
 */
function runInstall(slug: string, seed?: string, runs = 1): InstallRun {
  const home = scratchHome();
  const claudePath = path.join(home, ".claude", "CLAUDE.md");
  if (seed !== undefined) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(claudePath, seed);
  }

  let stdout = "";
  for (let i = 0; i < runs; i++) {
    stdout = runCli(home, ["install", slug], ` on run ${i + 1} of ${runs}`);
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
    stdout,
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
 * Where two markdown blobs first part company, as a readable report.
 *
 * A raw string `expect` on a 4000-character markdown section reports as one
 * unreadable blob, which is how a golden test stops being read and starts being
 * re-baselined.
 */
function firstDivergence(expected: string, actual: string): string {
  const a = expected.split("\n");
  const b = actual.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return (
    `  first divergence at line ${i + 1} (${a.length} lines vs ${b.length} lines)\n` +
    `  expected: ${JSON.stringify(a[i] ?? "<end of file>")}\n` +
    `  actual:   ${JSON.stringify(b[i] ?? "<end of file>")}`
  );
}

/**
 * The command that re-records this fixture, quoted into a failure message.
 * Slug-scoped where a slug owns the fixture, so re-recording one snippet cannot
 * quietly take the other ten with it.
 */
function recordCommand(slug?: string): string {
  const scope = slug ? `GOLDEN_SLUGS=${slug} ` : "";
  return `UPDATE_GOLDEN=1 ${scope}bun test src/install.golden.test.ts`;
}

/** Compare against the checked-in fixture, or record it under UPDATE_GOLDEN. */
function expectGolden(relPath: string, actual: string, slug?: string): void {
  const file = path.join(goldenDir, relPath);
  if (UPDATE) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, actual);
    return;
  }
  if (!fs.existsSync(file)) {
    throw new Error(
      `no fixture for ${relPath}. Either this slug is new, or the fixture was ` +
      `deleted. Read __fixtures__/install-golden/BASELINE.md, then record it ` +
      `with:\n  cd packages/cli && ${recordCommand(slug)}`,
    );
  }
  const expected = fs.readFileSync(file, "utf8");
  if (actual === expected) return;
  throw new Error(
    `${relPath} no longer matches the recorded output.\n` +
    firstDivergence(expected, actual) + "\n" +
    `If the change was intended, read BASELINE.md and re-record with:\n` +
    `  cd packages/cli && ${recordCommand(slug)}`,
  );
}

const seed = fs.readFileSync(seedPath, "utf8");

/**
 * Every line of seed.md that belongs to the user — the file minus each run that
 * starts at a `## ` heading and ends at a `<!-- /codecast-… -->` marker.
 *
 * Derived from the seed instead of copied out of it, so editing the seed cannot
 * leave a stale list behind that quietly stops guarding anything.
 */
function userLinesOf(text: string): string[] {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inOwnedBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inOwnedBlock && line.startsWith("## ")) {
      for (let j = i + 1; j < lines.length && !lines[j].startsWith("## "); j++) {
        if (lines[j].includes("<!-- /codecast-")) { inOwnedBlock = true; break; }
      }
    }
    if (inOwnedBlock) {
      if (line.includes("<!-- /codecast-")) inOwnedBlock = false;
      continue;
    }
    if (line.trim()) kept.push(line);
  }
  return kept;
}

const seedUserLines = userLinesOf(seed);

/**
 * The user's own text survived, checked against the seed rather than against a
 * fixture — a fixture re-recorded from a writer that started eating user prose
 * would simply record the loss.
 */
function expectUserTextIntact(slug: string, scenario: string, claudeMd: string): void {
  const lost = seedUserLines.filter((line) => !claudeMd.includes(line));
  expect(`${slug}/${scenario} dropped user lines: ${JSON.stringify(lost)}`).toBe(
    `${slug}/${scenario} dropped user lines: []`,
  );
}

const manifest: Record<string, unknown> = {};

/** Config keys in sorted order, so the manifest diff never churns on write order. */
function sortConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(config).sort()) out[key] = config[key];
  return out;
}

interface ManifestEntry {
  config: Record<string, string | boolean>;
  stdout: string;
  wroteClaudeMd: boolean;
  otherFiles: Record<string, string>;
}

function readManifest(file: string): Record<string, ManifestEntry> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, ManifestEntry>;
}

/**
 * Compare the bugs the fixtures still show against the ones filed in this file.
 *
 * A known-bug list is only useful if it invalidates itself. Failing in BOTH
 * directions is the point: a new offender means the bug spread, and a
 * disappeared one means somebody fixed it and the note is now a lie about the
 * code. Neither is answered by re-recording, so both messages say what to
 * change instead.
 */
function expectKnownBugs(found: string[], filed: string[], subject: string, guidance: string): void {
  const left = found.join(", ") || "none";
  const right = filed.join(", ") || "none";
  if (left === right) return;
  throw new Error(`${subject}: ${left}\n  filed in this file: ${right}\n${guidance}`);
}

describe("cast install — golden output per catalog slug", () => {
  for (const descriptor of slugs) {
    const slug = descriptor.slug;

    test(`${slug} — fresh HOME, seeded CLAUDE.md, and a second run over its own output`, () => {
      const fresh = runInstall(slug);
      const existing = runInstall(slug, seed);
      const settled = runInstall(slug, seed, 2);

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
        config: sortConfig(fresh.config),
        stdout: fresh.stdout,
        wroteClaudeMd: fresh.claudeMd !== ABSENT,
        otherFiles: fresh.files,
      };

      expectUserTextIntact(slug, "existing", existing.claudeMd);
      expectUserTextIntact(slug, "settled", settled.claudeMd);

      if (settled.claudeMd !== existing.claudeMd) {
        throw new Error(
          `installing ${slug} twice does not settle: the second run changed the ` +
          `file again, so every upgrade rewrites it.\n` +
          firstDivergence(existing.claudeMd, settled.claudeMd) + "\n" +
          `This is a writer bug, not a stale fixture — do not re-record.`,
        );
      }

      expectGolden(path.join("fresh", `${slug}.md`), fresh.claudeMd, slug);
      expectGolden(path.join("existing", `${slug}.md`), existing.claudeMd, slug);
    }, 120_000);
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
    const recorded = readManifest(file);
    // Key sets first. Comparing only the slugs that filed an entry would let a
    // slug whose own test failed — or one dropped from the catalog entirely —
    // pass this test by being absent from both sides of the loop.
    if (!only) {
      const expected = slugs.map((d) => d.slug).join(", ");
      expect(`ran: ${Object.keys(manifest).join(", ")}`).toBe(`ran: ${expected}`);
      expect(`recorded: ${Object.keys(recorded).join(", ")}`).toBe(`recorded: ${expected}`);
    }
    for (const slug of Object.keys(manifest)) {
      expect(`${slug}: ${JSON.stringify(manifest[slug])}`).toBe(
        `${slug}: ${JSON.stringify(recorded[slug])}`,
      );
    }
  });

  // `cast install -h` is the only place a user reads the slug list, and the one
  // surface that names a snippet the catalog does not: `stable` is a
  // SessionStart hook, printed by a hand-written line under a generated one
  // (index.ts:9532). That line is what goes stale when the catalog moves.
  test("cast install -h is unchanged", () => {
    expectGolden("help.txt", runCli(scratchHome(), ["install", "-h"]));
    // If `stable` ever became a catalog slug, the generated rows and the
    // hand-written line would both print it and the help would list it twice.
    expect(SNIPPET_CATALOG.map((d) => d.slug)).not.toContain("stable");
  }, 60_000);

  test("no live fixture carries the CLI package version", () => {
    // The one thing that would make this golden churn on every release. If a
    // snippet body or the help screen ever interpolates the version, catch it
    // here rather than discovering it as a mystery failure the day after a
    // version bump. pre-rewrite/ is excluded: it is frozen, so a hit there
    // could never be fixed, only tolerated.
    const pkgVersion = JSON.parse(
      fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8"),
    ).version as string;
    const live = ["help.txt"];
    for (const dir of ["fresh", "existing"]) {
      const abs = path.join(goldenDir, dir);
      if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs)) live.push(path.join(dir, name));
    }
    for (const rel of live) {
      const body = fs.readFileSync(path.join(goldenDir, rel), "utf8");
      expect(`${rel} contains ${pkgVersion}: ${body.includes(pkgVersion)}`)
        .toBe(`${rel} contains ${pkgVersion}: false`);
    }
  });

  // Reads the two checked-in fixture sets, not the CLI, so it costs nothing and
  // stays honest under UPDATE_GOLDEN — re-recording a changed body without
  // bumping its version makes this fail rather than making the evidence vanish.
  test("a body that changed since the pre-rewrite baseline also bumped its version", () => {
    const before = readManifest(path.join(preRewriteDir, "manifest.json"));
    const after = readManifest(path.join(goldenDir, "manifest.json"));

    const stale: string[] = [];
    for (const descriptor of SNIPPET_CATALOG) {
      const oldBody = path.join(preRewriteDir, "fresh", `${descriptor.slug}.md`);
      // No pre-rewrite body means the rewrite left this slug's fresh output
      // untouched, or the slug post-dates the baseline. Nothing to compare.
      if (!fs.existsSync(oldBody)) continue;
      const nowBody = path.join(goldenDir, "fresh", `${descriptor.slug}.md`);
      if (fs.readFileSync(oldBody, "utf8") === fs.readFileSync(nowBody, "utf8")) continue;
      const wasVersion = before[descriptor.slug]?.config?.[descriptor.versionKey];
      const nowVersion = after[descriptor.slug]?.config?.[descriptor.versionKey];
      if (wasVersion === nowVersion) stale.push(descriptor.slug);
    }

    expectKnownBugs(
      stale,
      BODY_CHANGED_WITHOUT_VERSION_BUMP,
      "bodies changed without a version bump",
      `A slug listed on the left changed its text but kept its version, so no ` +
      `installed machine will ever receive the new text — bump it in src/update.ts. ` +
      `A slug that disappeared was fixed: delete it from ` +
      `BODY_CHANGED_WITHOUT_VERSION_BUMP.`,
    );
  });

  test("a success line names only files the install actually wrote", () => {
    const recorded = readManifest(path.join(goldenDir, "manifest.json"));
    const liars = Object.entries(recorded)
      .filter(([, e]) => !e.wroteClaudeMd && e.stdout.includes("CLAUDE.md"))
      .map(([slug]) => slug);

    expectKnownBugs(
      liars,
      STDOUT_NAMES_A_FILE_IT_DID_NOT_WRITE,
      "success lines naming a CLAUDE.md the install never wrote",
      `The success line is built from the CLAUDE.md target list regardless of what ` +
      `the snippet writes (index.ts:9601). Print what the writer touched, then ` +
      `delete the fixed slug from STDOUT_NAMES_A_FILE_IT_DID_NOT_WRITE.`,
    );
  });
});
