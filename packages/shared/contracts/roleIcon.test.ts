import { expect, test } from "bun:test";
import { isRoleIcon, parseRoleIconSvg, pickRoleIconAccent, roleIconProblems, roleIconSvg, roleMonogram, type RoleIcon } from "./roleIcon";

const database: RoleIcon = {
  v: 1, concept: "database", accent: "blue",
  shapes: [
    { t: "ellipse", cx: 12, cy: 5.5, rx: 7, ry: 2.5 },
    { t: "path", d: "M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" },
    { t: "path", d: "M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" },
  ],
};

test("a drawn icon round-trips through parse and render", () => {
  expect(isRoleIcon(database)).toBe(true);
  const svg = roleIconSvg(database, { strokeWidth: 2.1 });
  expect(svg).toContain('viewBox="0 0 24 24"');
  expect(svg).toContain('stroke-width="2.1"');
  const back = parseRoleIconSvg(svg);
  expect(back.problems).toEqual([]);
  expect(back.shapes).toEqual(database.shapes);
});

test("parsing drops presentation but refuses anything that moves or runs", () => {
  const ok = parseRoleIconSvg('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="red" class="x"/></svg>');
  expect(ok.problems).toEqual([]);
  expect(ok.shapes).toEqual([{ t: "circle", cx: 12, cy: 12, r: 1.5, fill: true }]);
  expect(parseRoleIconSvg('<path d="M1 1L2 2" transform="rotate(9)"/>').problems[0]).toContain("transform");
  expect(parseRoleIconSvg('<g transform="scale(2)"><path d="M1 1"/></g>').problems.length).toBeGreaterThan(0);
  expect(parseRoleIconSvg('<script>alert(1)</script>').problems.length).toBeGreaterThan(0);
  expect(parseRoleIconSvg('<path d="M1 1" onload="x()"/>').problems[0]).toContain("onload");
  expect(parseRoleIconSvg('<svg viewBox="0 0 48 48"><path d="M1 1"/></svg>').problems[0]).toContain("viewBox");
});

test("validation names what is wrong", () => {
  expect(roleIconProblems({ ...database, shapes: [{ t: "path", d: 'M1 1"/><script>' }] })[0]).toContain("path commands");
  expect(roleIconProblems({ ...database, shapes: [{ t: "circle", cx: 12, cy: 12, r: 6, fill: true }] })[0]).toContain("dot");
  expect(roleIconProblems({ ...database, shapes: [{ t: "rect", x: 20, y: 2, width: 8, height: 4 }] })[0]).toContain("grid");
  expect(roleIconProblems({ ...database, accent: "pink" })[0]).toContain("accent");
  expect(() => roleIconSvg({ ...database, shapes: [] })).toThrow();
});

test("accents spread and monograms skip filler", () => {
  expect(pickRoleIconAccent(["blue", "cyan", "green", "yellow", "orange", "red", "magenta"], "x")).toBe("violet");
  expect(pickRoleIconAccent([], "a")).toBe(pickRoleIconAccent([], "a"));
  expect(roleMonogram("Infrastructure lead")).toBe("I");
  expect(roleMonogram("Head of Growth")).toBe("G");
  expect(roleMonogram("")).toBe("?");
});

// Paths validate by being drawn (flattenRoleIconPath): what passes always
// renders, and every point it reaches sits on the grid.
test("a path that cannot be drawn, or that leaves the grid, is a problem", async () => {
  const { flattenRoleIconPath } = await import("./roleIcon");
  const withPath = (d: string): RoleIcon => ({ v: 1, concept: "mark", accent: "blue", shapes: [{ t: "path", d }] });
  for (const d of ["M2 2 L4", "M2 2L4 4Z 5 5", "e", "M2 2 L3 3 1", "L2 2", "M2 2a4 4 0 2 1 4 4"]) {
    expect(roleIconProblems(withPath(d)).length, d).toBeGreaterThan(0);
    expect(() => flattenRoleIconPath(d), d).toThrow();
  }
  expect(roleIconProblems(withPath("M-50 -50 L74 74"))).toEqual(["shape 1 (path): every point must sit inside the 24 grid"]);
  expect(roleIconProblems(withPath("M1e999 1e999 L2 2"))).toEqual(["shape 1 (path): every point must sit inside the 24 grid"]);
  // An arc that bulges past the edge leaves the grid even though its ends do not.
  expect(roleIconProblems(withPath("M2 12a10 10 0 0 1 20 0"))).toEqual([]); // top of the arc at y 2
  expect(roleIconProblems(withPath("M2 2a10 10 0 0 1 20 0"))).toEqual(["shape 1 (path): every point must sit inside the 24 grid"]); // top at y -8
  // Compact arc flags and relative curves read as SVG reads them.
  expect(roleIconProblems(withPath("M4 12a8 8 0 1 1 16 0A8 8 0 0 1 4 12zm4 0a4 4 0 014 4"))).toEqual([]);
  expect(roleIconProblems(withPath("M3 12c0-6 6-6 6 0s6 6 6 0q3-8 6 0"))).toEqual([]);
});

test("a concept is plain words", () => {
  for (const concept of ["coin", "org chart", "jack-o'-lantern"]) expect(roleIconProblems({ ...database, concept })).toEqual([]);
  for (const concept of ["\u001b[31mred", "coin 2", "9 lives", "a".repeat(41)]) expect(roleIconProblems({ ...database, concept }).length, concept).toBe(1);
});
