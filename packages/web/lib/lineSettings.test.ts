import { describe, expect, test } from "bun:test";
import type { PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { LINE_FIELDS, LINE_STATION_SETTINGS, LINE_SETTINGS_SECTIONS, applyLineEdits, editKey, lineSettingsHref, lineSettingsTarget, commandNote, editForField, editOutcome, lineEditStatus, lineValue, lineWriteGate } from "./lineSettings";

const field = (key: string) => LINE_FIELDS.find((f) => f.key === key)!;

const profile = (over: Partial<PublishedLineProfile> = {}): PublishedLineProfile => ({
  finders: [{ id: "sentry-web", source: "sentry", kind: ["bug"], fingerprint: "sentry:<issue>" }],
  root: "/src/app",
  default: true,
  changed_at: 1,
  team: null,
  project: "pr-1",
  principles: [],
  prompting: "https://example.com/prompting.md",
  size_budget: 400,
  watch_days: 7,
  commands: { check: "cast ws check", prove: null, eval: null, ship: null },
  caps: { cards: 5 },
  sources: { "commands.check": "default", size_budget: "file", "caps.cards": "default", finders: "file" },
  notes: ["no prove command: the prove station passes with a note", "no eval command: the eval station passes with a note", "no ship command: the ship station runs Ship, which opens a pull request and merges only under [line.merge] auto or the line's role's merge grant"],
  warnings: [],
  file: ".codecast/line.toml",
  device_id: "mac",
  published_at: 2,
  ...over,
});

describe("editForField", () => {
  test("a number must be a whole number of 1 or more; the same value sends nothing", () => {
    const lp = profile();
    expect(editForField(field("size_budget"), "0", lp)).toEqual({ error: "A whole number, 1 or more" });
    expect(editForField(field("size_budget"), "2.5", lp)).toHaveProperty("error");
    expect(editForField(field("size_budget"), "400", lp)).toEqual({ edit: null });
    expect(editForField(field("size_budget"), " 250 ", lp)).toEqual({ edit: { op: "set", key: "size_budget", value: 250 } });
  });

  test("clearing a value the file sets puts it back to the default; clearing a default sends nothing", () => {
    const lp = profile();
    expect(editForField(field("size_budget"), "", lp)).toEqual({ edit: { op: "remove", key: "size_budget" } });
    expect(editForField(field("caps.cards"), "  ", lp)).toEqual({ edit: null });
  });

  test("a list splits on lines and commas", () => {
    expect(editForField(field("principles"), "docs/a.md,\n docs/b.md\n", profile())).toEqual({ edit: { op: "set", key: "principles", value: ["docs/a.md", "docs/b.md"] } });
  });
});

describe("applyLineEdits", () => {
  test("a set paints the value as the file's, a remove as the default's, and the notes follow the commands", () => {
    const lp = profile();
    applyLineEdits(lp, [{ op: "set", key: "commands.prove", value: "bun test repro" }, { op: "remove", key: "size_budget" }]);
    expect(lp.commands!.prove).toBe("bun test repro");
    expect(lp.sources!["commands.prove"]).toBe("file");
    expect(lp.size_budget).toBe(400);
    expect(lp.sources!.size_budget).toBe("default");
    expect(commandNote(lp, "commands.prove")).toBeNull();
    expect(commandNote(lp, "commands.eval")).toBe("the eval station passes with a note");
  });

  test("finders are added, replaced and removed by id", () => {
    const lp = profile();
    applyLineEdits(lp, [{ op: "set_finder", finder: { id: "evals", source: "evals", kind: "regression", fingerprint: "evals:<surface>" } }]);
    expect(lp.finders.map((f) => f.id)).toEqual(["sentry-web", "evals"]);
    expect(lp.finders[1].kind).toEqual(["regression"]);
    applyLineEdits(lp, [{ op: "set_finder", finder: { id: "sentry-web", source: "sentry", kind: "any", fingerprint: "s:<x>", runs: "cast trigger tr-1" } }]);
    expect(lp.finders[0]).toEqual({ id: "sentry-web", source: "sentry", kind: "any", fingerprint: "s:<x>", runs: "cast trigger tr-1" });
    applyLineEdits(lp, [{ op: "remove_finder", id: "evals" }]);
    expect(lp.finders.map((f) => f.id)).toEqual(["sentry-web"]);
  });

  test("a station edit paints the repo's line (LX5) and keys its state by station", () => {
    const lp = profile();
    const edit = { op: "set_station", station: "prove", timeout: 600 } as const;
    applyLineEdits(lp, [edit]);
    expect(lp.line!.nodes.find((n) => n.id === "prove")!.timeout).toBe(600);
    expect(lp.finders.map((f) => f.id)).toEqual(["sentry-web"]);
    expect(editKey(edit)).toBe("stations.prove");
    expect(editKey({ op: "reset_station", station: "red" })).toBe("stations.red");
  });

  test("an older row without values reads the defaults", () => {
    expect(lineValue({ finders: [], changed_at: 1 }, "commands.check")).toBe("cast ws check");
    expect(lineValue({ finders: [], changed_at: 1 }, "commands.ship")).toBeNull();
  });
});

describe("lineWriteGate", () => {
  test("writable on the viewer's online machine, read only with the reason otherwise", () => {
    const lp = profile();
    expect(lineWriteGate(lp, [{ device_id: "mac", online: true, label: "Studio" }])).toMatchObject({ writable: true, device: "Studio" });
    // A quiet machine still takes the edit: the roster runs stale under load, and the command waits for it.
    expect(lineWriteGate(lp, [{ device_id: "mac", online: false, label: "Studio" }])).toMatchObject({ writable: true, device: "Studio", away: true });
    expect(lineWriteGate(lp, [{ device_id: "other", online: true }])).toMatchObject({ writable: false, reason: expect.stringMatching(/teammate's machine/) });
    expect(lineWriteGate({ finders: [], changed_at: 1, root: "/r" }, [])).toMatchObject({ writable: false, reason: expect.stringMatching(/older codecast/) });
    expect(lineWriteGate(null, [])).toMatchObject({ writable: false, reason: expect.stringMatching(/no machine has uploaded them yet/) });
    // Nothing published but a known checkout: the defaults edit, and the first edit publishes.
    expect(lineWriteGate(null, [], "/Users/a/src/union")).toMatchObject({ writable: true, first: true });
    expect(lineWriteGate({ finders: [], changed_at: 1, root: "/r" }, [], "/r")).toMatchObject({ writable: false, reason: expect.stringMatching(/older codecast/) });
  });
});

describe("editOutcome", () => {
  test("reads the daemon's answer", () => {
    expect(editOutcome(undefined)).toEqual({ state: "waiting" });
    expect(editOutcome({ executed_at: 1, error: "/src/app/.codecast/line.toml: [line] size_budget must be a positive integer" })).toEqual({ state: "refused", message: "size_budget must be a positive integer" });
    expect(editOutcome({ executed_at: 1, error: "expired_ttl" })).toMatchObject({ state: "refused", message: expect.stringMatching(/within 5 minutes.*Nothing reached the file/) });
    expect(editOutcome({ executed_at: 1, error: "Unknown command: line_profile_edit" })).toMatchObject({ state: "refused", message: expect.stringMatching(/older cast/) });
    expect(editOutcome({ executed_at: 1, error: 'unknown edit op "set_station" (ops: set, remove, set_finder, remove_finder)' })).toMatchObject({ state: "refused", message: expect.stringMatching(/older cast that cannot edit the line's stations/) });
    expect(editOutcome({ executed_at: 1, result: JSON.stringify({ changed: true, published: { ok: true } }) })).toEqual({ state: "saved" });
    expect(editOutcome({ executed_at: 1, result: JSON.stringify({ changed: true, published: { ok: false, detail: "no project" } }) })).toMatchObject({ state: "saved", note: expect.stringMatching(/republish failed: no project/) });
    // A daemon that republishes after it answers: written, and the row follows.
    expect(editOutcome({ executed_at: 1, result: JSON.stringify({ changed: true, published: { ok: "pending" } }) })).toEqual({ state: "saved" });
  });
});

describe("lineEditStatus", () => {
  const row = (result: object) => ({ _id: "r1", requested_at: 1_000, executed_at: 1_300, command_id: "c1", result: JSON.stringify(result), error: null, edits: [{ op: "set" as const, key: "watch_days", value: 8 }] });
  test("the machine's own republish lands before it answers: the edit is saved, not still republishing", () => {
    expect(lineEditStatus(row({ changed: true, published: { ok: true } }), profile({ published_at: 1_200 }), 2_000).state).toBe("saved");
  });
  test("a copy published before the request does not carry the edit", () => {
    expect(lineEditStatus(row({ changed: true, published: { ok: true } }), profile({ published_at: 900 }), 2_000).state).toBe("publishing");
  });
  test("a republish still pending waits for a copy stamped after the answer", () => {
    expect(lineEditStatus(row({ changed: true, published: { ok: "pending" } }), profile({ published_at: 1_200 }), 2_000).state).toBe("publishing");
    expect(lineEditStatus(row({ changed: true, published: { ok: "pending" } }), profile({ published_at: 1_400 }), 2_000).state).toBe("saved");
  });
});

describe("links into the settings page", () => {
  test("one address: project, then section, and a station implies Stations", () => {
    expect(lineSettingsHref()).toBe("/line/settings");
    expect(lineSettingsHref({ project: "pj-a", section: "limits" })).toBe("/line/settings?project=pj-a&section=limits");
    expect(lineSettingsHref({ project: "pj-a", section: "checks", station: "verify" })).toBe("/line/settings?project=pj-a&section=stations&station=verify");
    expect(lineSettingsHref({ project: null, section: null })).toBe("/line/settings");
  });
  test("the page reads back what the link asked, and ignores a section it does not have", () => {
    const read = (q: string) => lineSettingsTarget(new URLSearchParams(q));
    expect(read(lineSettingsHref({ project: "pj-a", station: "ground" }).split("?")[1])).toEqual({ section: "stations", station: "ground" });
    expect(read("project=pj-a&section=listens")).toEqual({ section: "listens", station: null });
    expect(read("station=ground")).toEqual({ section: "stations", station: "ground" });
    expect(read("section=nope")).toEqual({ section: null, station: null });
    expect(lineSettingsTarget(null)).toEqual({ section: null, station: null });
  });
  test("every Line page station names a real section", () => {
    for (const s of Object.values(LINE_STATION_SETTINGS)) expect(LINE_SETTINGS_SECTIONS).toContain(s.section);
  });
});
