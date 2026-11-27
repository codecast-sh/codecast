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

test("before Send: a Start links where its priority's team will read it, and says why not otherwise", async () => {
  const { startLinkForecast } = await import("../priorityStartLink");
  const codecast = { team_id: "cc", team_name: "Codecast", visibility: "private" };
  expect(startLinkForecast("team:cc", codecast, {})).toEqual({ kind: "private", team: "Codecast" });
  expect(startLinkForecast("team:cc", codecast, { visibility: "summary" })).toBeNull();
  expect(startLinkForecast("team:cc", { ...codecast, visibility: "full" }, {})).toBeNull();
  expect(startLinkForecast("team:cc", codecast, { team: true })).toBeNull();
  expect(startLinkForecast("team:cc", { team_id: "un", team_name: "Union", visibility: "full" }, {})).toEqual({ kind: "folder", team: "Union" });
  expect(startLinkForecast("team:cc", null, {})).toEqual({ kind: "locked" });
  expect(startLinkForecast("team:cc", undefined, {})).toBeNull();
  expect(startLinkForecast("user:me", null, {})).toBeNull();
  expect(startLinkForecast("user:me", { team_id: "un", team_name: "Union", visibility: "full" }, {})).toEqual({ kind: "folder", team: "Union" });
});
