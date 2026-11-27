// The priorities feeders (hooks/usePriorities): /priorities' feeder and the
// inbox host's make the identical priorities.list call, so Convex holds one
// subscription and neither snapshot drops the other's rows; the inbox's runs
// while any workspace the viewer holds has Priorities on; and the header's
// pass timing is its own small query (priorities.timing), never the list.
// Run: cd packages/web && bun test --isolate hooks/usePriorities.feeders.test.tsx
import { expect, mock, test } from "bun:test";
import { installDom, installMissingBackend, seedViewer, TEAM_ID } from "../test-helpers/missingBackend";

installDom("https://app.test/priorities");
await installMissingBackend({ answers: {} });
await seedViewer();

const feeds: Array<{ name: string; args: unknown }> = [];
const reads: Array<{ name: string; args: unknown }> = [];
const { getFunctionName } = await import("convex/server");
const realSync = { ...(await import("./useSyncCollection")) };
mock.module("./useSyncCollection", () => ({
  ...realSync,
  useSyncCollection: (key: string, ref: unknown, args: unknown) => { feeds.push({ name: `${key}<-${getFunctionName(ref as any)}`, args }); return { ready: true }; },
}));
const realQuery = { ...(await import("./useQueryNoThrow")) };
mock.module("./useQueryNoThrow", () => ({
  ...realQuery,
  useQueryNoThrow: (ref: unknown, args: unknown) => { reads.push({ name: getFunctionName(ref as any), args }); return { data: undefined }; },
}));

const React = await import("react");
const { useInboxStore } = await import("../store/inboxStore");
const { usePriorityListMeta, useSyncInboxPriorities, useSyncPriorities } = await import("./usePriorities");
const { mountSurface } = await import("../test-helpers/missingBackend");

const setTeams = (features: Record<string, boolean>) => useInboxStore.getState().syncTable("teams", [
  { _id: TEAM_ID, name: "Active", role: "admin", features: { priorities: !!features.active } },
  { _id: "team-other", name: "Other", role: "member", features: { priorities: !!features.other } },
] as any);

function Feeders() {
  useSyncPriorities();
  useSyncInboxPriorities();
  usePriorityListMeta();
  return null;
}

test("/priorities and the inbox host feed priorities.list with the identical args: one subscription", async () => {
  setTeams({ active: true });
  feeds.length = 0;
  const page = await mountSurface(React.createElement(Feeders));
  try {
    const lists = feeds.filter((f) => f.name === "priorities<-priorities:list");
    expect(lists).toHaveLength(2);
    expect(lists[0].args).not.toBe("skip");
    expect(lists[1].args).toBe(lists[0].args);
    expect(lists[0].args).toEqual({});
  } finally {
    await page.unmount();
  }
});

test("the inbox feeder runs while any workspace has Priorities on, the active one off included; none on, it skips", async () => {
  setTeams({ active: false, other: true });
  feeds.length = 0;
  const on = await mountSurface(React.createElement(Feeders));
  await on.unmount();
  expect(feeds.filter((f) => f.name === "priorities<-priorities:list").every((f) => f.args !== "skip")).toBe(true);
  setTeams({});
  feeds.length = 0;
  const off = await mountSurface(React.createElement(Feeders));
  await off.unmount();
  expect(feeds.filter((f) => f.name === "priorities<-priorities:list").map((f) => f.args)).toEqual([{}, "skip"]);
});

test("the header's pass timing reads priorities.timing for the active workspace, never the list", async () => {
  setTeams({ active: true });
  reads.length = 0;
  const page = await mountSurface(React.createElement(Feeders));
  try {
    expect(reads.map((r) => r.name)).toContain("priorities:timing");
    expect(reads.filter((r) => r.name === "priorities:timing").at(-1)!.args).toEqual({ workspace: `team:${TEAM_ID}` });
    expect(reads.some((r) => r.name === "priorities:list")).toBe(false);
  } finally {
    await page.unmount();
  }
});
