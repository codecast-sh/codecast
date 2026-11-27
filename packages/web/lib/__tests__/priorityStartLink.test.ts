// A Start whose link the server refused is told, never left silent (lib/priorityStartLink).
import { expect, test } from "bun:test";
import { startLinkVerdict } from "../priorityStartLink";

const start = { priority: "pri-7", priority_step: "s1" };

test("only the server's row decides: the local stub (no priority_id yet) waits", () => {
  expect(startLinkVerdict(undefined, start, "team:t1")).toBeNull();
  expect(startLinkVerdict({ is_private: false }, start, "team:t1")).toBeNull();
  expect(startLinkVerdict({ priority_id: "p7" }, start, "team:t1")).toBe("linked");
});

test("a session its folder keeps in another team says whose folder it is", () => {
  const names = (id: string) => (id === "union" ? "Union" : undefined);
  expect(startLinkVerdict({ priority_id: null, team_id: "union", is_private: false }, start, "team:codecast", names)).toBe("This folder belongs to Union, so the session isn't on pri-7");
  expect(startLinkVerdict({ priority_id: null, team_id: "union", is_private: false }, start, "user:me", names)).toMatch(/belongs to Union/);
});

test("a refused link says why: a private session cannot sit on a team priority; anything else names the priority", () => {
  expect(startLinkVerdict({ priority_id: null, is_private: true }, start, "team:t1")).toMatch(/private.*pri-7/);
  expect(startLinkVerdict({ priority_id: null, is_private: false }, start, "team:t1")).toMatch(/isn't on pri-7/);
  expect(startLinkVerdict({ priority_id: null, is_private: true }, start, "user:me")).toMatch(/isn't on pri-7/);
});
