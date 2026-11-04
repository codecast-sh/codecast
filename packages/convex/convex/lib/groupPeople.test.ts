import { describe, expect, test } from "bun:test";
import { clusterPeople, mergeStoredPeople, userKeys } from "./groupPeople";

describe("groupPeople", () => {
  test("every identifier is a key, normalized", () => {
    expect(userKeys({ id: "A1", email: " Ada@X.org ", name: "" })).toEqual(["a1", "ada@x.org"]);
    expect(userKeys(undefined)).toEqual([]);
  });

  test("an id on one event and an id plus email on the next are one person", () => {
    const c = clusterPeople([{ id: "anon-1", email: "ada@x.org" }, { email: "ada@x.org" }, { id: "user-9", email: "ada@x.org" }, { id: "bob" }]);
    expect(c.length).toBe(2);
    expect(c.find((k) => k.includes("ada@x.org"))!.sort()).toEqual(["ada@x.org", "anon-1", "user-9"]);
  });

  test("a person stored under two keys counts once, and their missing alias is added", () => {
    const clusters = clusterPeople([{ id: "anon-1", email: "ada@x.org" }, { id: "user-9", email: "ada@x.org" }]);
    expect(mergeStoredPeople(clusters, new Set(["anon-1", "user-9"]))).toEqual({ over: 1, add: ["ada@x.org"] });
  });

  test("a person the stored rows never held adds nothing", () => {
    expect(mergeStoredPeople(clusterPeople([{ id: "z" }]), new Set(["a"]))).toEqual({ over: 0, add: [] });
  });
});
