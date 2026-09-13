import { expect, spyOn, test } from "bun:test";
import { setAvailableSkills } from "./conversations";
import { getCurrentUser } from "./users";
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
  const current = await (getCurrentUser as any)._handler(ctxFor(db), {});
  expect(JSON.parse(current.available_skills)).toEqual({ "/other": SKILLS, "/repo": SKILLS });
  expect(db._tables.users[0].available_skills).toBeUndefined();
});

test("skill reports exceeding one record retain every project in separate rows", async () => {
  const large = [{ name: "build", description: "x".repeat(22_000) }];
  const legacy = Object.fromEntries(Array.from({ length: 46 }, (_, i) => [`/old-${i}`, large]));
  const db = makeFakeDb({ users: [{ _id: USER }], user_skills: [{ _id: "user_skills_owner", user_id: USER, skills_json: JSON.stringify(legacy), updated_at: 10 }] });
  for (let i = 0; i < 3; i++) {
    await (setAvailableSkills as any)._handler(ctxFor(db), { project_path: `/new-${i}`, skills: JSON.stringify(large) });
  }
  for (const row of db._tables.user_skills) expect(new TextEncoder().encode(JSON.stringify(row)).byteLength).toBeLessThan(1_048_576);
  const current = await (getCurrentUser as any)._handler(ctxFor(db), {});
  expect(Object.keys(JSON.parse(current.available_skills))).toHaveLength(49);
});

test("project rows override legacy values without losing untouched legacy projects", async () => {
  const db = makeFakeDb({ users: [{ _id: USER, available_skills: JSON.stringify({ "/other": SKILLS, "/repo": SKILLS }) }] });
  await (setAvailableSkills as any)._handler(ctxFor(db), { project_path: "/repo", skills: "[]" });
  await (setAvailableSkills as any)._handler(ctxFor(db), { project_path: "/new", skills: JSON.stringify(SKILLS) });
  const current = await (getCurrentUser as any)._handler(ctxFor(db), {});
  expect(JSON.parse(current.available_skills)).toEqual({ "/other": SKILLS, "/repo": [], "/new": SKILLS });
  expect(db._tables.user_skills.find((row: any) => row.project_path === "/repo")?.skills_json).toBe("[]");
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
