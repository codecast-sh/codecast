// Turning agent features on from the setup flow: only machines that are
// online and have reported their setup are sent anything, and only the
// features they lack. The setup-flow path rule keeps intros off those pages.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { SNIPPET_CATALOG } from "@codecast/shared/contracts";
import { useInboxStore } from "../../../store/inboxStore";
import { applyAgentFeatures, setPendingAgentFeatures } from "../agentFeatures";
import { isSetupFlowPath } from "../../../lib/setupFlow";

const memory = SNIPPET_CATALOG.find((s) => s.slug === "memory")!;
const tasks = SNIPPET_CATALOG.find((s) => s.slug === "tasks")!;

// The store is shared across a run's test files: put back the two actions
// these tests replace.
const original = { setDeviceSnippet: useInboxStore.getState().setDeviceSnippet, updateClientUI: useInboxStore.getState().updateClientUI };
afterAll(() => useInboxStore.setState(original as any));

const device = (id: string, online: boolean, snippets?: Record<string, boolean>) =>
  ({ device_id: id, label: id, platform: "darwin", last_seen: 0, is_remote: false, local_project_roots: [], online, settings: snippets ? { snippets } : undefined }) as any;

describe("applyAgentFeatures", () => {
  let sent: Array<[string, string]>;
  beforeEach(() => {
    sent = [];
    useInboxStore.setState({ setDeviceSnippet: mock(async (id: string, c: { snippet: string }) => { sent.push([id, c.snippet]); }) } as any);
  });

  test("sends each missing feature to each reporting online machine", () => {
    const n = applyAgentFeatures(
      [device("a", true, { memory: true }), device("b", true, {}), device("off", false, {}), device("new", true)],
      [memory, tasks],
    );
    expect(n).toBe(3);
    expect(sent.sort()).toEqual([["a", tasks.wireSlug ?? "tasks"], ["b", "memory"], ["b", tasks.wireSlug ?? "tasks"]].sort());
  });
});

describe("setPendingAgentFeatures", () => {
  test("keeps the choice in the synced UI bag", () => {
    let wrote: any;
    useInboxStore.setState({ updateClientUI: (p: any) => { wrote = p; } } as any);
    setPendingAgentFeatures(["memory"]);
    expect(wrote.agent_features_pending.slugs).toEqual(["memory"]);
  });
});

describe("isSetupFlowPath", () => {
  test("names the three setup pages and nothing else", () => {
    for (const p of ["/start", "/start/", "/settings/team/create", "/settings/team/join"]) expect(isSetupFlowPath(p)).toBe(true);
    for (const p of ["/inbox", "/settings/team", "/starter", null]) expect(isSetupFlowPath(p)).toBe(false);
  });
});
