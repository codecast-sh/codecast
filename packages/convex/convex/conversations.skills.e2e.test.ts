import { expect, spyOn, test } from "bun:test";
import { setAvailableSkills } from "./conversations";
import { makeFakeDb } from "./testDb";

const USER = "users_owner";
const SKILLS = [{ name: "build", description: "Build the project" }];
const ctxFor = (db: ReturnType<typeof makeFakeDb>) => ({ db, auth: { getUserIdentity: async () => ({ subject: `${USER}|session` }) } });

test("repeated skill reports leave the shared row untouched", async () => {
  const db = makeFakeDb({ users: [{ _id: USER }], user_skills: [{ _id: "user_skills_owner", user_id: USER, skills_json: JSON.stringify({ "/repo": SKILLS }), updated_at: 10 }] });
  const patch = spyOn(db, "patch");
  for (let i = 0; i < 10; i++) await (setAvailableSkills as any)._handler(ctxFor(db), { project_path: "/repo", skills: JSON.stringify(SKILLS) });
  expect(patch).not.toHaveBeenCalled();
  expect(db._tables.user_skills[0].updated_at).toBe(10);
  patch.mockRestore();
});

test("changed skills preserve the other projects and remove the legacy user blob", async () => {
  const db = makeFakeDb({ users: [{ _id: USER, available_skills: "[]" }], user_skills: [{ _id: "user_skills_owner", user_id: USER, skills_json: JSON.stringify({ "/other": SKILLS }), updated_at: 10 }] });
  await (setAvailableSkills as any)._handler(ctxFor(db), { project_path: "/repo", skills: JSON.stringify(SKILLS) });
  expect(JSON.parse(db._tables.user_skills[0].skills_json)).toEqual({ "/other": SKILLS, "/repo": SKILLS });
  expect(db._tables.users[0].available_skills).toBeUndefined();
});

test("an unchanged side table still sheds the legacy user blob", async () => {
  const db = makeFakeDb({ users: [{ _id: USER, available_skills: JSON.stringify(SKILLS) }], user_skills: [{ _id: "user_skills_owner", user_id: USER, skills_json: JSON.stringify({ global: SKILLS }), updated_at: 10 }] });
  const patch = spyOn(db, "patch");
  await (setAvailableSkills as any)._handler(ctxFor(db), { skills: JSON.stringify(SKILLS) });
  expect(patch).toHaveBeenCalledTimes(1);
  expect(patch).toHaveBeenCalledWith(USER, { available_skills: undefined });
  expect(db._tables.user_skills[0].updated_at).toBe(10);
  patch.mockRestore();
});
