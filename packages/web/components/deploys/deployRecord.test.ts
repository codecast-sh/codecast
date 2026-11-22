import { describe, expect, test } from "bun:test";
import { NAMES_SHOWN, changeGroups, hasChangeNames, originWords, shownNames } from "./deployRecord";

// A list row as the targets feed sends it (counts only), and the deploy itself (names).
const row = { short_id: "dp-9", machine: "ana-mac", pushed_via: "dev watcher", dirty: 3, adds_count: 1, drops_count: 2 };
const view = { machine: "ana-mac", pushed_via: "dev watcher", dirty: 3, adds: ["fn:a:b"], drops: ["table:voiceprints", "index:voiceprints.by_user"] };

describe("deploy record", () => {
  test("says where a push came from, leaving out what was not recorded", () => {
    expect(originWords(row)).toBe("dev watcher · ana-mac · 3 uncommitted files");
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
