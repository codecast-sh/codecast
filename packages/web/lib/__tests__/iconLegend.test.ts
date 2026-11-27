import { afterAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { GROUP_ORDER, MARKS, MARK_BY_ID, type MarkDef } from "../marks";
import { SESSION_STATUS, SESSION_STATUSES } from "../sessionStatus";
import { glyphKey, legendBox, legendGroups, readMarks } from "../iconLegend";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { CHANGE_PREFIX, type PriorityChangeKind } from "@codecast/shared/contracts/priorityCard";
import { changeMarkId } from "../marks/changes";

describe("mark registry", () => {
  test("ids are unique", () => {
    expect(MARK_BY_ID.size).toBe(MARKS.length);
  });

  test("names are unique inside a group, ignoring case: two rows under one header never read alike", () => {
    const byName = new Map<string, string[]>();
    for (const m of MARKS) {
      const k = `${m.group}: ${m.name.toLowerCase()}`;
      byName.set(k, [...(byName.get(k) ?? []), m.id]);
    }
    expect([...byName].filter(([, ids]) => ids.length > 1)).toEqual([]);
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

  test("every change the priorities pass proposes draws a registered mark, both ways for a move", () => {
    for (const kind of Object.keys(CHANGE_PREFIX) as PriorityChangeKind[]) {
      for (const down of [false, true]) expect(MARK_BY_ID.get(changeMarkId(kind, down))?.group).toBe("Priorities pass");
    }
    expect(changeMarkId("move", true)).not.toBe(changeMarkId("move", false));
  });
});

const dot = (size: number, extra = "") => `<svg data-status-mark="working" viewBox="0 0 10 10" width="${size}" height="${size}" aria-hidden="true" class="shrink-0 text-sol-green ${extra}"><circle cx="5" cy="5" r="3.5"></circle></svg>`;
const ring = `<svg viewBox="0 0 10 10" width="10" height="10" class="shrink-0 text-sol-green"><circle cx="5" cy="5" r="3.6" stroke-dasharray="2 1.55"></circle></svg>`;

const B = { w: 10, h: 10 };
const seenOf = (id: string, markup: string, box = B) => ({ id, markup, box });

describe("legend rows", () => {
  test("the same glyph at two sizes is one variant", () => {
    expect(glyphKey(dot(8))).toBe(glyphKey(dot(10)));
    expect(glyphKey(dot(10, "size-3"))).toBe(glyphKey(dot(10)));
    expect(glyphKey(dot(10))).not.toBe(glyphKey(ring));
  });

  test("one row per meaning, distinct glyphs side by side, in the order seen", () => {
    const groups = legendGroups([
      seenOf("session.working", dot(10)),
      seenOf("session.working", dot(8)),
      seenOf("session.working", ring),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[0].rows[0].glyphs.map((g) => g.seen.markup)).toEqual([dot(10), ring]);
  });

  test("a mark drawn from data (oneGlyph) keeps only the first glyph seen", () => {
    const marks: MarkDef[] = [{ id: "test.strip", name: "S", meaning: "s", group: "Priorities", oneGlyph: true }];
    const groups = legendGroups([seenOf("test.strip", "a"), seenOf("test.strip", "b")], undefined, marks);
    expect(groups[0].rows[0].glyphs.map((g) => g.seen.markup)).toEqual(["a"]);
  });

  test("rows follow registry order inside a group; unknown ids are dropped", () => {
    const groups = legendGroups([seenOf("session.done", "d"), seenOf("nope", "x"), seenOf("session.needs_you", "n")]);
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
    const seen = [seenOf("test.work", "w"), seenOf("session.idle", "i"), seenOf("test.pass", "p")];
    expect(legendGroups(seen, undefined, marks).map((g) => g.group)).toEqual(["Priorities pass", "Sessions", "Work"]);
    expect(legendGroups(seen, "Work", marks).map((g) => g.group)).toEqual(["Work", "Priorities pass", "Sessions"]);
  });

  test("a glyph is drawn at its page size and scaled to fit 20px tall and 48px wide, at least 8px a side", () => {
    const groups = legendGroups([seenOf("session.working", "<svg class=\"size-full\"></svg>", { w: 12, h: 12 })]);
    expect(groups[0].rows[0].glyphs[0].fit).toEqual({ w: 12, h: 12, scale: 1 });
    // A ten-day strip: width-bound, so it shrinks to 48px wide.
    expect(legendBox({ w: 60, h: 20 })).toEqual({ w: 48, h: 16, scale: 0.8 });
    // A tall glyph: height-bound at 20px.
    expect(legendBox({ w: 20, h: 40 })).toEqual({ w: 10, h: 20, scale: 0.5 });
    expect(legendBox({ w: 6, h: 6 })).toEqual({ w: 8, h: 8, scale: 1 });
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
    <span data-mark="session.error" id="titled"><svg><title>Background work</title><desc>more</desc><path d="M0 0"></path></svg></span>
    <div data-icon-legend><span data-mark="session.error"><svg></svg></span></div>
  </body>`);
  afterAll(() => closeDomWindow(dom));
  const doc = dom.window.document;

  test("takes bare marks the predicate sees, with a copy of their glyph; skips labeled ones and the legend's own", () => {
    const seen = readMarks(doc, (el) => el.id === "bare");
    expect(seen.map(({ id, markup }) => ({ id, markup }))).toEqual([{ id: "session.working", markup: dot(10) }]);
    expect(seen[0].glyph.innerHTML).toBe(doc.getElementById("bare")!.innerHTML);
    expect(seen[0].glyph).not.toBe(doc.getElementById("bare"));
  });

  test("a copied glyph carries no svg title or description", () => {
    const [m] = readMarks(doc, (el) => el.id === "titled");
    expect(m.markup).toBe(`<svg><path d="M0 0"></path></svg>`);
    expect(m.glyph.textContent).toBe("");
    expect(doc.getElementById("titled")!.querySelector("title")).not.toBeNull();
  });

  test("asks the predicate only about candidates", () => {
    const asked: string[] = [];
    readMarks(doc, (el) => { asked.push(el.dataset.mark!); return true; });
    expect(asked).toEqual(["session.working", "session.idle", "session.error"]);
  });
});

describe("tinted marks", () => {
  const diamond = (color: string) => `<span data-mark="entity.project" data-mark-tinted class="w-3"><span class="size-1.5 rotate-45 ${color}"></span></span>`;
  const dom = new JSDOM(`<!doctype html><body>
    ${diamond("bg-sol-violet")}
    ${diamond("bg-red-500 dark:bg-red-400")}
    <span data-mark="entity.project" data-mark-tinted><svg class="size-3 text-sol-cyan" fill="#123456" style="stroke: rgb(1, 2, 3)"><path d="M0 0" fill="red"></path></svg></span>
    <span data-mark="session.working"><svg class="text-sol-green"></svg></span>
    <span data-mark="session.working"><svg class="text-sol-red"></svg></span>
  </body>`);
  afterAll(() => closeDomWindow(dom));
  const seen = readMarks(dom.window.document, () => true);

  test("every project's diamond is one variant; the folder glyph is a second on the same row", () => {
    const rows = legendGroups(seen).flatMap((g) => g.rows);
    expect(rows.find((r) => r.def.id === "entity.project")!.glyphs).toHaveLength(2);
  });

  test("a tinted copy wears no colour of its own: its paint is currentColor in neutral ink", () => {
    const [a, , folder] = seen;
    expect(a.glyph.getAttribute("style")).toContain("var(--sol-text-muted)");
    const dot = a.glyph.firstElementChild as HTMLElement;
    expect(dot.getAttribute("class")).toBe("size-1.5 rotate-45");
    expect(dot.style.backgroundColor).toBe("currentcolor");
    expect(folder.markup).not.toMatch(/sol-cyan|#123456|rgb\(1, 2, 3\)|"red"/);
    expect(folder.markup).toContain("size-3");
  });

  test("an untinted mark's colours still tell variants apart", () => {
    const rows = legendGroups(seen).flatMap((g) => g.rows);
    expect(rows.find((r) => r.def.id === "session.working")!.glyphs).toHaveLength(2);
  });
});
