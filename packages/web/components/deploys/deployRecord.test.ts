import { describe, expect, test } from "bun:test";
import { NAMES_SHOWN, changeGroups, devPushWords, hasChangeNames, originWords, shownNames } from "./deployRecord";

// A list row as the targets feed sends it (counts only), and the deploy itself (names).
const row = { short_id: "dp-9", machine: "ana-mac", pushed_via: "deploy.sh", dirty: 3, adds_count: 1, drops_count: 2 };
const view = { machine: "ana-mac", pushed_via: "deploy.sh", dirty: 3, adds: ["fn:a:b"], drops: ["table:voiceprints", "index:voiceprints.by_user"] };

describe("deploy record", () => {
  test("says where a push came from, leaving out what was not recorded", () => {
    expect(originWords(row)).toBe("deploy.sh · ana-mac · 3 uncommitted files");
    expect(originWords({ pushed_via: "deploy.sh", machine: "ci-box", dirty: 0 })).toBe("deploy.sh · ci-box");
    expect(originWords({ machine: null, dirty: null }, { machine: "ana-mac", dirty: 1 })).toBe("ana-mac · 1 uncommitted file");
  });

  test("a deploy with none of the fields has no origin, no groups and nothing to fetch", () => {
    const old = { _id: "x", short_id: "dp-1", status: "live" };
    expect(originWords(old)).toBeNull();
    expect(changeGroups(old)).toEqual([]);
    expect(hasChangeNames(old)).toBe(false);
    const empty = { machine: null, pushed_via: null, dirty: null, adds_count: 0, drops_count: 0 };
    expect(changeGroups(empty, { adds: [], drops: [] })).toEqual([]);
    expect(hasChangeNames(empty)).toBe(false);
  });

  test("counts from the row before the names arrive, then lists them, dropped first", () => {
    expect(hasChangeNames(row)).toBe(true);
    expect(changeGroups(row).map((g) => [g.kind, g.label, g.names])).toEqual([["dropped", "Dropped 2", []], ["added", "Added 1", []]]);
    expect(changeGroups(row, view).map((g) => [g.kind, g.label, g.names])).toEqual([
      ["dropped", "Dropped 2", ["table:voiceprints", "index:voiceprints.by_user"]],
      ["added", "Added 1", ["fn:a:b"]],
    ]);
    expect(changeGroups(undefined, view).map((g) => g.label)).toEqual(["Dropped 2", "Added 1"]);
  });

  test("holds back past the first few until expanded", () => {
    const names = Array.from({ length: NAMES_SHOWN + 7 }, (_, i) => `fn:m:f${i}`);
    expect(shownNames(names, false)).toEqual({ shown: names.slice(0, NAMES_SHOWN), more: 7 });
    expect(shownNames(names, true)).toEqual({ shown: names, more: 0 });
    expect(shownNames(names.slice(0, NAMES_SHOWN), false).more).toBe(0);
  });
});

describe("a target's dev push", () => {
  const NOW = 1_700_000_000_000;
  const push = { sha: "1a2b3c4d5e", machine: "ana-mac", by: "Ana", at: NOW - 3 * 60_000, dirty: 2, adds_count: 0, drops_count: 0 };

  test("reads as one line: what, where, who, when, how many files", () => {
    expect(devPushWords(push, NOW)).toBe("uncommitted push · ana-mac · Ana · 3m ago · 2 files");
    expect(devPushWords({ ...push, dirty: 1, at: NOW - 10_000 }, NOW)).toBe("uncommitted push · ana-mac · Ana · just now · 1 file");
  });

  test("says what it added and dropped only when it did, and leaves out an unknown pusher", () => {
    expect(devPushWords({ ...push, by: null, adds_count: 1, drops_count: 2 }, NOW)).toBe("uncommitted push · ana-mac · 3m ago · 2 files · added 1 · dropped 2");
    expect(devPushWords({ ...push, machine: null }, NOW)).toBe("uncommitted push · Ana · 3m ago · 2 files");
  });

  test("a push of a clean tree names its sha", () => {
    expect(devPushWords({ ...push, dirty: 0 }, NOW)).toBe("dev push of 1a2b3c4 · ana-mac · Ana · 3m ago");
  });
});
