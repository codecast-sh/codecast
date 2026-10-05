import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { lineProfileLockKey } from "../lineSlice";
import { LINE_PROFILE_DEFAULTS, lineProfileNotes, type PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";

const s = () => useInboxStore.getState() as any;
const PID = "p".repeat(32);

const profile = (over: Partial<PublishedLineProfile> = {}): PublishedLineProfile => ({
  ...structuredClone(LINE_PROFILE_DEFAULTS),
  finders: [],
  root: "/repo",
  device_id: "dev-1",
  publisher_user_id: "u",
  sources: { size_budget: "default" },
  notes: lineProfileNotes(LINE_PROFILE_DEFAULTS),
  warnings: [],
  changed_at: 1,
  published_at: 1,
  ...over,
} as PublishedLineProfile);

const row = (lp: PublishedLineProfile, extra: Record<string, unknown> = {}) => ({ _id: PID, title: "P", line_profile: lp, ...extra });

let calls: Array<[string, unknown[]]> = [];
const owner = {};
beforeAll(() => s()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return { command_id: "c1" }; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  calls = [];
  useInboxStore.setState({ projects: {}, pending: {} } as any);
  s().syncTable("projects", [row(profile())], { isDelta: true });
});

describe("editLineProfile", () => {
  it("paints at once and holds the paint against a push of the row for another reason", () => {
    s().editLineProfile(PID, [{ op: "set", key: "size_budget", value: 250 }]);
    expect(s().projects[PID].line_profile.size_budget).toBe(250);
    expect(s().pending[lineProfileLockKey(PID)]?.type).toBe("field");
    // task_counts moved; the server still has the old profile.
    s().syncTable("projects", [row(profile(), { task_counts: { total: 3 } })], { isDelta: true });
    expect(s().projects[PID].line_profile.size_budget).toBe(250);
  });

  it("settles on the republished row, whose timestamps the paint could not know", () => {
    s().editLineProfile(PID, [{ op: "set", key: "size_budget", value: 250 }]);
    // A stale push first: content differs, so the lock stays.
    s().syncTable("projects", [row(profile(), { task_counts: { total: 3 } })], { isDelta: true });
    s().settleLineProfile(PID);
    expect(s().pending[lineProfileLockKey(PID)]).toBeDefined();
    // The republish: same content, new clocks.
    const echo = profile({ size_budget: 250, sources: { size_budget: "file" }, changed_at: 9, published_at: 9 });
    s().syncTable("projects", [row(echo)], { isDelta: true });
    s().settleLineProfile(PID);
    expect(s().pending[lineProfileLockKey(PID)]).toBeUndefined();
    expect(s().projects[PID].line_profile.changed_at).toBe(9);
    expect(s().projects[PID].line_profile.size_budget).toBe(250);
  });

  it("a refusal puts the key back and keeps the lock in step with it", () => {
    const prior = structuredClone(s().projects[PID].line_profile);
    s().editLineProfile(PID, [{ op: "set", key: "size_budget", value: 250 }]);
    s().restoreLineProfile(PID, prior, ["size_budget"]);
    expect(s().projects[PID].line_profile.size_budget).toBe(400);
    s().syncTable("projects", [row(profile(), { task_counts: { total: 3 } })], { isDelta: true });
    expect(s().projects[PID].line_profile.size_budget).toBe(400);
  });
});
