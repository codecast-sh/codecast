import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { GROUP_ORDER, MARKS, MARK_BY_ID, type MarkDef } from "../marks";
import { SESSION_STATUS, SESSION_STATUSES } from "../sessionStatus";
import { glyphKey, legendGroups, readMarks } from "../iconLegend";
import { closeDomWindow } from "../../test-helpers/domGlobals";

describe("mark registry", () => {
  test("ids are unique", () => {
    expect(MARK_BY_ID.size).toBe(MARKS.length);
  });

  test("every mark's group is in GROUP_ORDER, which names each group once", () => {
    expect(new Set(GROUP_ORDER).size).toBe(GROUP_ORDER.length);
    for (const m of MARKS) expect(GROUP_ORDER).toContain(m.group);
  });

  test("every mark has a name and a meaning", () => {
    for (const m of MARKS) {
      expect(m.name.trim()).not.toBe("");
      expect(m.meaning.trim()).not.toBe("");
    }
  });

  test("session marks are the status vocabulary's nine states, word for word", () => {
    const sessions = MARKS.filter((m) => m.group === "Sessions");
    expect(sessions.map((m) => m.id)).toEqual(SESSION_STATUSES.map((s) => `session.${s}`));
    for (const s of SESSION_STATUSES) {
      const m = MARK_BY_ID.get(`session.${s}`)!;
      expect({ name: m.name, meaning: m.meaning }).toEqual({ name: SESSION_STATUS[s].word, meaning: SESSION_STATUS[s].meaning });
    }
  });
});

const dot = (size: number, extra = "") => `<svg data-status-mark="working" viewBox="0 0 10 10" width="${size}" height="${size}" aria-hidden="true" class="shrink-0 text-sol-green ${extra}"><circle cx="5" cy="5" r="3.5"></circle></svg>`;
const ring = `<svg viewBox="0 0 10 10" width="10" height="10" class="shrink-0 text-sol-green"><circle cx="5" cy="5" r="3.6" stroke-dasharray="2 1.55"></circle></svg>`;

describe("legend rows", () => {
  test("the same glyph at two sizes is one variant", () => {
    expect(glyphKey(dot(8))).toBe(glyphKey(dot(10)));
    expect(glyphKey(dot(10, "size-3"))).toBe(glyphKey(dot(10)));
    expect(glyphKey(dot(10))).not.toBe(glyphKey(ring));
  });

  test("one row per meaning, distinct glyphs side by side, in the order seen", () => {
    const groups = legendGroups([
      { id: "session.working", markup: dot(10) },
      { id: "session.working", markup: dot(8) },
      { id: "session.working", markup: ring },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].glyphs).toEqual([dot(10), ring]);
  });

  test("rows follow registry order inside a group; unknown ids are dropped", () => {
    const groups = legendGroups([
      { id: "session.done", markup: "d" },
      { id: "nope", markup: "x" },
      { id: "session.needs_you", markup: "n" },
    ]);
    expect(groups.map((g) => g.group)).toEqual(["Sessions"]);
    expect(groups[0].rows.map((r) => r.def.id)).toEqual(["session.needs_you", "session.done"]);
  });

  test("groups follow GROUP_ORDER, with a lead group first", () => {
    // Stand-in marks for the other groups, so ordering holds before those families are filled.
    const marks: MarkDef[] = [
      ...MARKS,
      { id: "test.work", name: "W", meaning: "w", group: "Work" },
      { id: "test.pass", name: "P", meaning: "p", group: "Priorities pass" },
    ];
    const seen = [{ id: "test.work", markup: "w" }, { id: "session.idle", markup: "i" }, { id: "test.pass", markup: "p" }];
    expect(legendGroups(seen, undefined, marks).map((g) => g.group)).toEqual(["Priorities pass", "Sessions", "Work"]);
    expect(legendGroups(seen, "Work", marks).map((g) => g.group)).toEqual(["Work", "Priorities pass", "Sessions"]);
  });

  test("nothing seen is no groups", () => {
    expect(legendGroups([])).toEqual([]);
  });
});

describe("reading the page", () => {
  const dom = new JSDOM(`<!doctype html><body>
    <span data-mark="session.working" id="bare">${dot(10)}</span>
    <span data-mark="session.done" data-mark-labeled id="labeled"><svg></svg></span>
    <span data-mark="session.idle" id="hidden"><svg></svg></span>
    <div data-icon-legend><span data-mark="session.error"><svg></svg></span></div>
  </body>`);
  afterAll(() => closeDomWindow(dom));
  const doc = dom.window.document;

  test("takes bare marks the predicate sees, with their glyph; skips labeled ones and the legend's own", () => {
    const seen = readMarks(doc, (el) => el.id !== "hidden");
    expect(seen).toEqual([{ id: "session.working", markup: dot(10) }]);
  });

  test("asks the predicate only about candidates", () => {
    const asked: string[] = [];
    readMarks(doc, (el) => { asked.push(el.dataset.mark!); return true; });
    expect(asked).toEqual(["session.working", "session.idle"]);
  });
});
