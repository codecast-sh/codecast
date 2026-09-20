import { expect, test } from "bun:test";
import { initiativeTabTitle, tabTitle } from "./tabTitle";

const initiatives = {
  team: { title: "Team plan", short_id: "in-1", workspace: "team:a" },
  personal: { title: "Private plan", short_id: "in-2", workspace: "user:me", team_id: "a" },
  other: { title: "Other plan", short_id: "in-3", workspace: "team:b" },
};

test("initiative titles resolve ids and short ids only in the active workspace", () => {
  expect(initiativeTabTitle("/initiatives/team", initiatives, "team:a")).toBe("Team plan");
  expect(initiativeTabTitle("/initiatives/IN-1?tab=tasks", initiatives, "team:a")).toBe("Team plan");
  expect(initiativeTabTitle("/initiatives/personal", initiatives, "team:a")).toBeNull();
  expect(initiativeTabTitle("/initiatives/in-2", initiatives, "team:a")).toBeNull();
  expect(initiativeTabTitle("/initiatives/in-2", initiatives, "user:me")).toBe("Private plan");
  expect(initiativeTabTitle("/initiatives/in-3", initiatives, "team:a")).toBeNull();
  expect(initiativeTabTitle("/initiatives/in-1", initiatives, null)).toBeNull();
});

test("tab titles forward the workspace boundary", () => {
  const tab = { id: "t", path: "/initiatives/in-2" };
  expect(tabTitle(tab as any, {}, {}, [], "me", initiatives, "user:me")).toBe("Private plan");
  expect(tabTitle(tab as any, {}, {}, [], "me", initiatives, "team:a")).not.toBe("Private plan");
});
