import { expect, mock, test } from "bun:test";

const spawned: any[] = [];
const opened: string[] = [];
// mock.module reaches every file in a combined run, so each mock keeps the
// module's real exports and replaces only the one this test watches.
const realSpawn = await import("../spawnSession");
const realOpen = await import("../../hooks/useOpenLinkedSession");
mock.module("../spawnSession", () => ({ ...realSpawn, spawnSessionWithPrompt: (input: any) => { spawned.push(input); return { stubId: "stub-1" }; } }));
mock.module("../../hooks/useOpenLinkedSession", () => ({ ...realOpen, openConversationBeside: (id: string) => { opened.push(id); } }));

const { useInboxStore } = await import("../../store/inboxStore");
const { startSharingAgent, SHARING_AGENT_PROMPT } = await import("../sharingAgent");

test("the sharing agent starts private, where new sessions start, briefed on cast sharing, and opens beside the page", () => {
  useInboxStore.setState({
    currentConversation: { ...useInboxStore.getState().currentConversation, projectPath: undefined, gitRoot: undefined },
    activeProjectFilter: null,
    activeProjectPath: null,
    recentProjects: [{ path: "/Users/ada/src/app" }] as any,
    machineRoster: undefined as any,
  });
  expect(startSharingAgent()).toBe("stub-1");
  expect(spawned).toHaveLength(1);
  expect(spawned[0]).toMatchObject({ private: true, projectPath: "/Users/ada/src/app", prompt: SHARING_AGENT_PROMPT });
  expect(opened).toEqual(["stub-1"]);
});

test("started from the settings modal, the modal closes so the conversation is in view", () => {
  useInboxStore.setState({ settingsModalSection: "sync" as any });
  startSharingAgent();
  expect(useInboxStore.getState().settingsModalSection).toBeNull();
});

test("the brief names the commands and asks before anything that exposes the past or deletes", () => {
  for (const words of ["cast sharing", "cast sharing --help", "cast sharing sessions", "--dry-run", "cast update", "Change nothing until I agree"]) {
    expect(SHARING_AGENT_PROMPT).toContain(words);
  }
});
