import { test, expect, describe } from "bun:test";
import {
  buildNavigatorRows,
  filterNavigatorRows,
  hiddenRowsNoun,
  formatTimeAgo,
  sampleTicks,
  activeTickIndex,
  pickStickyFallback,
  pickStickyFallbackFromLoaded,
  resolveStickyPrompt,
  navigatorHeaderLabels,
  countCommentsByMessage,
} from "../messageNavigator";
import { formatSessionMessage } from "../../components/sessionMessage";

const msg = (id: string, content: string, timestamp = 0) => ({ _id: id, content, timestamp });

const SESSION_WIRE = formatSessionMessage("jx7c6zk", "can you take the auth half?");
const TRIGGER_WIRE = '<scheduled-task title="Nightly audit">run the audit</scheduled-task>';

const MIXED = [
  msg("a", "fix the login bug"),
  msg("b", SESSION_WIRE),
  msg("c", "continue"),
  msg("d", "now add tests"),
  msg("e", TRIGGER_WIRE),
  msg("f", "   "),
];

describe("buildNavigatorRows", () => {
  test("numbering counts only user rows and skips hidden kinds and blanks", () => {
    const rows = buildNavigatorRows(MIXED);
    expect(rows.map((r) => [r._id, r.kind, r.originalIndex])).toEqual([
      ["a", "user", 0],
      ["b", "session", -1],
      ["c", "continue", -1],
      ["d", "user", 1],
      ["e", "schedule", -1],
    ]);
  });

  test("a bare continue nudge becomes a hidden row with an empty body", () => {
    const [row] = buildNavigatorRows([msg("c", "Continue!")]);
    expect(row.kind).toBe("continue");
    expect(row.display).toBe("");
  });

  test("session source resolves through the injected title lookup", () => {
    const [row] = buildNavigatorRows([msg("b", SESSION_WIRE)], null, (id) => (id === "jx7c6zk" ? "Auth fix" : null));
    expect(row.source).toBe("Auth fix");
    const [bare] = buildNavigatorRows([msg("b", SESSION_WIRE)]);
    expect(bare.source).toBe("jx7c6zk");
  });

  test("comment counts attach by message id", () => {
    const rows = buildNavigatorRows([msg("a", "hi"), msg("d", "there")], new Map([["d", 2]]));
    expect(rows.map((r) => r.commentCount)).toEqual([0, 2]);
  });

  test("slash commands keep the command label", () => {
    const [row] = buildNavigatorRows([msg("x", "<command-name>/commit</command-name>")]);
    expect(row.isCmd).toBe(true);
    expect(row.display).toBe("/commit");
  });
});

describe("hiddenRowsNoun", () => {
  test("precise when one kind, plural by count", () => {
    const rows = buildNavigatorRows([msg("1", SESSION_WIRE), msg("2", SESSION_WIRE)]).filter((r) => r.kind !== "user");
    expect(hiddenRowsNoun(rows)).toBe("sessions");
    expect(hiddenRowsNoun(rows.slice(0, 1))).toBe("session");
    const trigger = buildNavigatorRows([msg("3", TRIGGER_WIRE)]);
    expect(hiddenRowsNoun(trigger)).toBe("trigger");
  });

  test("other when kinds are mixed", () => {
    const rows = buildNavigatorRows(MIXED).filter((r) => r.kind !== "user");
    expect(hiddenRowsNoun(rows)).toBe("other");
  });
});

describe("filterNavigatorRows", () => {
  const rows = buildNavigatorRows(MIXED);

  test("hides the hidden kinds unless showHidden", () => {
    expect(filterNavigatorRows(rows, { search: "", showHidden: false }).map((r) => r._id)).toEqual(["a", "d"]);
    expect(filterNavigatorRows(rows, { search: "", showHidden: true }).map((r) => r._id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("search matches the display text and the source, case insensitive", () => {
    expect(filterNavigatorRows(rows, { search: "TESTS", showHidden: false }).map((r) => r._id)).toEqual(["d"]);
    expect(filterNavigatorRows(rows, { search: "jx7c6zk", showHidden: true }).map((r) => r._id)).toEqual(["b"]);
    expect(filterNavigatorRows(rows, { search: "nightly", showHidden: true }).map((r) => r._id)).toEqual(["e"]);
    expect(filterNavigatorRows(rows, { search: "jx7c6zk", showHidden: false })).toEqual([]);
  });
});

describe("formatTimeAgo", () => {
  test("buckets by minute, hour and day", () => {
    const now = 1_000_000_000_000;
    expect(formatTimeAgo(now - 10_000, now)).toBe("now");
    expect(formatTimeAgo(now - 5 * 60_000, now)).toBe("5m");
    expect(formatTimeAgo(now - 3 * 3_600_000, now)).toBe("3h");
    expect(formatTimeAgo(now - 4 * 86_400_000, now)).toBe("4d");
  });
});

describe("sampleTicks", () => {
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ _id: String(i), i }));

  test("5 rows under the cap give one tick per row", () => {
    const ticks = sampleTicks(rowsOf(5), 24, 3);
    expect(ticks.map((t) => t.row.i)).toEqual([0, 1, 2, 3, 4]);
    expect(ticks.map((t) => t.active)).toEqual([false, false, false, true, false]);
  });

  test("200 rows sample to the cap, keeping first and last", () => {
    const ticks = sampleTicks(rowsOf(200), 24, 199);
    expect(ticks.length).toBe(24);
    expect(ticks[0].row.i).toBe(0);
    expect(ticks[23].row.i).toBe(199);
    expect(ticks[23].active).toBe(true);
    const idx = ticks.map((t) => t.row.i);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(idx[1]).toBe(Math.round((1 / 23) * 199));
  });

  test("activeTickIndex prefers the current message, then scroll progress", () => {
    const rows = rowsOf(10);
    expect(activeTickIndex(rows, "7", 0)).toBe(7);
    expect(activeTickIndex(rows, "missing", 0.5)).toBe(5);
    expect(activeTickIndex(rows, null, 1)).toBe(9);
  });
});

describe("pickStickyFallback", () => {
  const user = (id: string, content: string, timestamp: number) => ({ _id: id, role: "user" as const, content, timestamp });
  const all = [
    user("p1", "first prompt", 100),
    user("p2", "second prompt", 200),
    user("n", "continue", 250),
    user("s", SESSION_WIRE, 260),
    user("p3", "third prompt", 300),
    user("p4", "fourth prompt", 400),
  ];

  test("picks the latest eligible prompt above the loaded window", () => {
    const loaded = new Set(["p3", "p4"]);
    expect(pickStickyFallback(all, loaded, 300)?.id).toBe("p2");
  });

  test("returns null when nothing sits above the window", () => {
    expect(pickStickyFallback(all, new Set(["p1", "p2", "p3", "p4"]), 100)).toBeNull();
    expect(pickStickyFallback([], new Set(), Infinity)).toBeNull();
    expect(pickStickyFallback(undefined, new Set(), Infinity)).toBeNull();
  });
});

describe("navigatorHeaderLabels", () => {
  test("splits human and hidden counts and formats the chip label", () => {
    const labels = navigatorHeaderLabels(buildNavigatorRows(MIXED));
    expect(labels.humanCount).toBe(2);
    expect(labels.hiddenCount).toBe(3);
    expect(labels.placeholder).toBe("Search 2 messages");
    expect(labels.chipLabel).toBe("3 other");
  });

  test("no hidden rows means no chip label, singular placeholder", () => {
    const labels = navigatorHeaderLabels(buildNavigatorRows([msg("a", "one prompt")]));
    expect(labels.hiddenCount).toBe(0);
    expect(labels.chipLabel).toBe("");
    expect(labels.placeholder).toBe("Search 1 message");
  });
});

describe("countCommentsByMessage", () => {
  test("counts per message id and skips entries without one", () => {
    const map = countCommentsByMessage([
      { message_id: "a" },
      { message_id: "a" },
      { message_id: "b" },
      { message_id: undefined },
    ]);
    expect(map?.get("a")).toBe(2);
    expect(map?.get("b")).toBe(1);
    expect(map?.size).toBe(2);
  });

  test("null summary stays null", () => {
    expect(countCommentsByMessage(null)).toBeNull();
    expect(countCommentsByMessage(undefined)).toBeNull();
  });
});

describe("pickStickyFallbackFromLoaded", () => {
  const user = (id: string, content: string, timestamp: number) => ({ _id: id, role: "user" as const, content, timestamp });
  const all = [
    user("p1", "first prompt", 100),
    user("p2", "second prompt", 200),
    user("p3", "third prompt", 300),
  ];

  test("builds the loaded set and earliest timestamp from the loaded list", () => {
    const loaded = [
      { _id: "p3", timestamp: 300 },
      { _id: "x", timestamp: 350 },
    ];
    expect(pickStickyFallbackFromLoaded(all, loaded)?.id).toBe("p2");
  });

  test("empty loaded window falls back to the latest prompt overall", () => {
    expect(pickStickyFallbackFromLoaded(all, [])?.id).toBe("p3");
    expect(pickStickyFallbackFromLoaded(undefined, [])).toBeNull();
  });
});

describe("resolveStickyPrompt", () => {
  const sticky = [2, 10, 25];

  test("latest sticky row at or above the top visible row", () => {
    expect(resolveStickyPrompt(sticky, 14, new Set([14, 15, 16]))).toEqual({ index: 10, hidden: false });
    expect(resolveStickyPrompt(sticky, 30, new Set([30]))).toEqual({ index: 25, hidden: false });
  });

  test("hides when the prompt row is itself visible", () => {
    expect(resolveStickyPrompt(sticky, 10, new Set([10, 11]))).toEqual({ index: 10, hidden: true });
  });

  test("null when the reader is above every prompt", () => {
    expect(resolveStickyPrompt(sticky, 1, new Set([1]))).toBeNull();
    expect(resolveStickyPrompt([], 5, new Set([5]))).toBeNull();
  });
});
