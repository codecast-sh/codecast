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

test("a priority the store holds no row of gets plain words, never a folder's team it cannot know", () => {
  expect(startLinkVerdict({ priority_id: null, team_id: "union", is_private: false }, start, undefined, () => "Union")).toBe("This session isn't on pri-7");
  expect(startLinkVerdict({ priority_id: null, is_private: true }, start, undefined)).toBe("This session isn't on pri-7");
});

test("the toast reads the priority's workspace off its detail when the list does not hold it (opened from its page or a pill)", async () => {
  const { sayIfStartUnlinked } = await import("../priorityStartLink");
  const { useInboxStore } = await import("../../store/inboxStore");
  useInboxStore.setState({
    priorities: {},
    priorityDetails: { p7: { _id: "p7", short_id: "pri-7", corrections: [], other_sessions: [], base: { _id: "p7", short_id: "pri-7", workspace: "team:union" } } },
    teams: [{ _id: "union", name: "Union" }],
    sessions: { ...useInboxStore.getState().sessions, linkverdict1: { _id: "linkverdict1", priority_id: null, team_id: "union", is_private: false } },
  } as any);
  const said: string[] = [];
  await sayIfStartUnlinked(Promise.resolve("linkverdict1"), start, (m) => said.push(m));
  await new Promise((r) => setTimeout(r, 0));
  // The session is in the priority's own team, so the folder is not the reason.
  expect(said).toEqual(["This session isn't on pri-7: that milestone can't take it"]);
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
