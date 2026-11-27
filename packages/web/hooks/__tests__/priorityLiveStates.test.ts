// usePriorityLiveStates' verdict for one session (liveStateOf), read the way
// each inbox files it: web's sidebar sets a hosted conversation that ended on
// a stop apart under "Couldn't finish", while the phone inbox keeps it under
// Needs You, so the phone's priorities say Needs you exactly when its own
// inbox does.
// Run: cd packages/web && bun test --isolate hooks/__tests__/priorityLiveStates.test.ts
import { expect, test } from "bun:test";
import { fixtureId, installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
await installMissingBackend({ answers: {} });
await seedViewer();

const { useInboxStore } = await import("../../store/inboxStore");
const { liveStateOf } = await import("../usePriorityModels");
const { NOW, seedNeedsYou } = await import("../../test-helpers/prioritiesList");

const id = fixtureId("crflow");
const hosted = (stop: string | null) => useInboxStore.setState((s: any) => ({ sessions: { ...s.sessions, [id]: { ...s.sessions[id], agent_type: "codecast", hosted_stop: stop } } }));
const state = (inbox?: "sidebar" | "phone") => liveStateOf(useInboxStore.getState() as any, id, NOW, inbox);

test("a session waiting on you needs you in both inboxes", () => {
  const unseed = seedNeedsYou("crflow");
  try {
    hosted(null);
    expect(state()).toBe("needs_you");
    expect(state("phone")).toBe("needs_you");
  } finally {
    unseed();
  }
});

test("a hosted conversation that ended on a stop: the sidebar files it apart, the phone keeps it under Needs You", () => {
  const unseed = seedNeedsYou("crflow");
  try {
    hosted("error");
    expect(state()).not.toBe("needs_you");
    expect(state("sidebar")).not.toBe("needs_you");
    expect(state("phone")).toBe("needs_you");
  } finally {
    unseed();
  }
});

test("a session the store does not hold has no live verdict in either inbox", () => {
  expect(state()).toBeUndefined();
  expect(state("phone")).toBeUndefined();
});
