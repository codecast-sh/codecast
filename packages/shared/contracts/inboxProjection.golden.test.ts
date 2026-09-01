import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  INBOX_PROJECTION_VERSION,
  INBOX_WINDOW_CAPS,
  digestProjection,
  fnv1a32,
  projectInbox,
  type InboxBucket,
  type InboxTruncation,
  type ProjectableInboxRow,
} from "./inboxProjection";
import { expandFixtureRows, resolveEpochRelative, type FixtureRowSpec } from "./__fixtures__/inboxProjectionGen";

// GOLDEN FIXTURES for the shared inbox projection (sync-convergence C3,
// "Validation plan"). Each file holds input rows and the expected membership,
// placement (bucket, work_state, fold), tally, truncation and digest that the
// shared module must produce for them — on Convex, in the web store, on
// mobile and in the daemon alike.
//
// The fixture set is TIED TO THE VERSION CONSTANT: GOLDEN_HASH_BY_VERSION pins
// a hash of every expected block under the version it belongs to. A behavior
// change fails the fixtures; regenerating them changes the hash, and the hash
// only matches again once INBOX_PROJECTION_VERSION is bumped and a new entry
// is added. Bumping the version without regenerating fails too (no entry).
// Either way a projection change cannot ship silently: the server and every
// client gate their compare on this constant (C6).
//
// Regenerate DELIBERATELY after an intended rule change:
//   INBOX_GOLDEN_REGEN=1 bun test packages/shared/contracts/inboxProjection.golden.test.ts
// then bump the version, add its hash below, and show the fixture diff in
// the same commit.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "inboxProjection");
const REGEN = process.env.INBOX_GOLDEN_REGEN === "1";

// The fixture epoch: minute-aligned, so "E" is a valid inboxEpoch.
const FIXTURE_EPOCH = 1_800_000_000_000;

const GOLDEN_HASH_BY_VERSION: Record<number, string> = {
  2: "abddb0d7cb6aaa51",
};

type Expected = {
  truncated: InboxTruncation[];
  tally: { shown: Record<InboxBucket, number>; folded: Record<InboxBucket, number> };
  set_digest: string;
  placements: Record<string, [bucket: string, work_state: string, below_fold: boolean]>;
};

type Fixture = {
  about: string;
  epoch: string | number;
  asking: string[];
  rows: FixtureRowSpec[];
  expected?: Expected;
};

function loadCases(): Array<{ name: string; file: string; fixture: Fixture; rows: ProjectableInboxRow[]; epoch: number; asking: Set<string> }> {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const file = path.join(DIR, f);
      const fixture = JSON.parse(fs.readFileSync(file, "utf-8")) as Fixture;
      const epoch = Number(resolveEpochRelative(fixture.epoch, FIXTURE_EPOCH));
      const rows = expandFixtureRows(fixture.rows, epoch) as unknown as ProjectableInboxRow[];
      // Asking ids are written as fixture tags; resolve them like row ids.
      const tagToId = new Map(rows.map((r) => [String(r._id), String(r._id)]));
      const asking = new Set(
        fixture.asking.map((tag) => {
          const resolved = expandFixtureRows([{ _id: tag }], epoch)[0]._id as string;
          if (!tagToId.has(resolved)) throw new Error(`${f}: asking tag ${tag} names no row`);
          return resolved;
        }),
      );
      return { name: f.replace(/\.json$/, ""), file, fixture, rows, epoch, asking };
    });
}

function actualFor(c: ReturnType<typeof loadCases>[number]): Expected {
  const p = projectInbox(c.rows, { showOld: false }, c.epoch, { asking: (id) => c.asking.has(id) });
  const placements: Expected["placements"] = {};
  for (const id of [...p.placements.keys()].sort()) {
    const pl = p.placements.get(id)!;
    placements[id] = [pl.bucket, pl.work_state, pl.below_fold];
  }
  return { truncated: p.truncated, tally: p.tally, set_digest: p.set_digest, placements };
}

// One hash over every expected block, in file order: fnv1a32 over the
// canonical JSON of (name, expected), folded through the digest lanes so a
// change anywhere — a bucket, a fold bit, a tally, a truncation flag — moves it.
function fixtureHash(cases: Array<{ name: string; expected: Expected }>): string {
  return digestProjection(cases.map((c) => [c.name, JSON.stringify(c.expected), false] as const));
}

const cases = loadCases();

if (REGEN) {
  for (const c of cases) {
    const next = { ...c.fixture, expected: actualFor(c) };
    fs.writeFileSync(c.file, JSON.stringify(next, null, 2) + "\n");
  }
  const hash = fixtureHash(cases.map((c) => ({ name: c.name, expected: actualFor(c) })));
  console.log(`[inboxProjection golden] regenerated ${cases.length} fixtures; GOLDEN_HASH_BY_VERSION[${INBOX_PROJECTION_VERSION}] = "${hash}"`);
}

describe("inbox projection golden fixtures", () => {
  it("covers every bucket, every truncation window and the fold", () => {
    const buckets = new Set<string>();
    const truncated = new Set<string>();
    let folded = 0;
    for (const c of cases) {
      const a = actualFor(c);
      for (const [, [bucket, , fold]] of Object.entries(a.placements)) {
        buckets.add(bucket);
        if (fold) folded++;
      }
      for (const t of a.truncated) truncated.add(t);
    }
    for (const b of ["questions", "pinned", "new", "needs_input", "done", "dormant", "working", "stashed", "dismissed", "hidden"]) {
      expect(buckets.has(b), `no fixture places a row in ${b}`).toBe(true);
    }
    // `idle` is in the alphabet for placeInboxRow callers (a killed row, a
    // blank dead one) but no projection MEMBER can land there: a blank row is
    // `new`, and a killed row is a member only through its pin, which outranks
    // the verdict. Pinned here so a rule change that opens the bucket is seen.
    expect(buckets.has("idle")).toBe(false);
    for (const w of ["recent", "pinned"]) expect(truncated.has(w), `no fixture overflows ${w}`).toBe(true);
    expect(folded).toBeGreaterThan(0);
  });

  for (const c of cases) {
    it(`byte-identical on ${c.name}`, () => {
      if (REGEN) return;
      expect(c.fixture.expected, `${c.name} has no expected block; run with INBOX_GOLDEN_REGEN=1`).toBeDefined();
      const actual = actualFor(c);
      expect(JSON.stringify(actual)).toBe(JSON.stringify(c.fixture.expected));
      // The digest in the file is the shared algorithm over the file's own
      // placements — a fixture cannot carry a digest its rows do not produce.
      const entries = Object.entries(actual.placements).map(([id, [bucket, , fold]]) => [id, bucket, fold] as const);
      expect(digestProjection(entries)).toBe(actual.set_digest);
    });
  }

  it("the pinned overflow fixture drops exactly the oldest pin", () => {
    const c = cases.find((x) => x.name === "pinned-overflow")!;
    const a = actualFor(c);
    expect(a.truncated).toEqual(["pinned"]);
    expect(Object.keys(a.placements).length).toBe(INBOX_WINDOW_CAPS.pinned + 1); // pins + fresh
    const pinIds = c.rows.filter((r) => r.inbox_pinned_at).map((r) => String(r._id));
    const oldest = pinIds.reduce((a, b) => {
      const ra = c.rows.find((r) => String(r._id) === a)!;
      const rb = c.rows.find((r) => String(r._id) === b)!;
      return (ra.inbox_pinned_at ?? 0) <= (rb.inbox_pinned_at ?? 0) ? a : b;
    });
    expect(a.placements[oldest]).toBeUndefined();
  });

  it("the recent overflow fixture keeps the dropped row through its pin", () => {
    const c = cases.find((x) => x.name === "recent-overflow")!;
    const a = actualFor(c);
    expect(a.truncated).toEqual(["recent"]);
    const pinned = c.rows.find((r) => r.inbox_pinned_at)!;
    expect(a.placements[String(pinned._id)]?.[0]).toBe("pinned");
    expect(Object.keys(a.placements).length).toBe(INBOX_WINDOW_CAPS.recent + 1);
  });

  it("the fixture hash is pinned under the current projection version", () => {
    if (REGEN) return;
    const hash = fixtureHash(cases.map((c) => ({ name: c.name, expected: c.fixture.expected! })));
    const pinned = GOLDEN_HASH_BY_VERSION[INBOX_PROJECTION_VERSION];
    expect(pinned, `no golden hash for projection v${INBOX_PROJECTION_VERSION}: regenerate and pin it`).toBeDefined();
    expect(hash).toBe(pinned);
    // The map never runs ahead of the constant: a hash for an unreleased
    // version means someone pinned fixtures without bumping the version.
    expect(Math.max(...Object.keys(GOLDEN_HASH_BY_VERSION).map(Number))).toBe(INBOX_PROJECTION_VERSION);
  });

  it("fnv1a32 is the reference FNV-1a over UTF-16 code units", () => {
    // Reference vectors (ASCII == code units): the empty string, "a", and a
    // long-enough phrase to exercise the multiply carry.
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("hello world")).toBe(0xd58b3fa7);
  });
});
