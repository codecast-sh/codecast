import { expect, test } from "bun:test";
import { applySlashSkill, matchSlashSkills, slashQueryAt } from "../sessionSkills";

test("a slash opens at the start of the text or a word, never inside one", () => {
  expect(slashQueryAt("/comp")).toEqual({ start: 0, query: "comp" });
  expect(slashQueryAt("please /Rev")).toEqual({ start: 7, query: "rev" });
  expect(slashQueryAt("and/or")).toBeNull();
  expect(slashQueryAt("done ")).toBeNull();
});

test("matching keeps list order and caps the count", () => {
  const skills = [{ name: "compact", description: "" }, { name: "review", description: "" }, { name: "cast-review", description: "" }];
  expect(matchSlashSkills(skills, "rev").map((s) => s.name)).toEqual(["review", "cast-review"]);
  expect(matchSlashSkills(skills, "", 2)).toHaveLength(2);
});

test("a pick replaces the whole token and puts the caret after it", () => {
  expect(applySlashSkill("please /rev now", 7, "review")).toEqual({ text: "please /review now", caret: 15 });
  expect(applySlashSkill("/co", 0, "compact")).toEqual({ text: "/compact ", caret: 9 });
});
