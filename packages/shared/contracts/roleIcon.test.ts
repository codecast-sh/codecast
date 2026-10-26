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
