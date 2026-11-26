// Linking and attribution stay on the vault's machine: two sessions working the
// same path on two Macs never stand in for each other, for a local vault, a
// host vault or a mirror.
import { installEditorDom } from "../../../../components/code/__tests__/editorDom";

installEditorDom();

const { afterAll, beforeEach, describe, expect, it } = await import("bun:test");
const { useInboxStore } = await import("../../../../store/inboxStore");
const { useVaultStore } = await import("../../../../store/vaultStore");
const { hostVaultId } = await import("../../../vault/hosts/routes");
const { useCodeStore } = await import("../../../../store/codeStore");
const { composeInVault, computeVaultAgentState, placeCandidates, vaultMachineOf, vaultPlaceOf, writerNow } = await import("../live");

const inboxBefore = useInboxStore.getState();
const vaultBefore = useVaultStore.getState();
afterAll(() => {
  useInboxStore.setState(inboxBefore as never, true);
  useVaultStore.setState(vaultBefore as never, true);
});

const now = Date.now();
const FILE = "/Users/a/src/app/src/math.ts";
const editing = (id: string, device: string, at: number) => ({
  _id: id,
  title: `On ${device}`,
  agent_type: "claude_code",
  project_path: "/Users/a/src/app",
  owner_device_id: device,
  updated_at: at,
  agent_status: "working",
  is_idle: false,
  is_connected: true,
  last_heartbeat: now,
});
const editCall = (id: string) => [{ _id: `${id}m`, role: "assistant", timestamp: now - 1000, tool_calls: [{ name: "Edit", input: { file_path: FILE } }] }];
const mirrorId = "mirror-app";
const hostId = hostVaultId("app", "mac2");

beforeEach(() => {
  useInboxStore.setState({
    currentUser: { _id: "u1" },
    localDevice: { viewer: "u1", deviceId: "mac1" },
    tabs: [],
    activeTabId: null,
    currentSessionId: null,
    // The other Mac's session is the more recent one, so recency alone picks it.
    sessions: { here: editing("here", "mac1", now - 60_000), there: editing("there", "mac2", now) },
    messages: { here: editCall("here"), there: editCall("there") },
  } as never);
  useVaultStore.setState({
    vaults: [
      { id: "local-app", root: "/Users/a/src/app", name: "app" },
      { id: hostId, root: "/Users/a/src/app", name: "app" },
    ],
    remoteVaults: [{ id: mirrorId, root: "/Users/a/src/app", name: "app", device_id: "mac2", last_synced_at: 1, remote: true }],
  } as never);
});

describe("a vault's machine", () => {
  it("is this window's daemon for a local vault, the host for a host vault, the source for a mirror", () => {
    expect(vaultMachineOf("local-app")).toBe("mac1");
    expect(vaultMachineOf(hostId)).toBe("mac2");
    expect(vaultMachineOf(mirrorId)).toBe("mac2");
  });
});

describe("a new session from the editor", () => {
  it("starts in the vault's folder on the vault's machine", () => {
    const opened: unknown[] = [];
    // The send boundary: the composer never opens.
    useInboxStore.setState({ openCompose: (text: string, context: unknown) => void opened.push([text, context]) } as never);
    for (const id of ["local-app", hostId, mirrorId]) expect(composeInVault(id, "x")).toBe(true);
    expect(composeInVault("nowhere", "x")).toBe(false);
    expect(opened).toEqual([
      ["x", { projectPath: "/Users/a/src/app", deviceId: "mac1" }],
      ["x", { projectPath: "/Users/a/src/app", deviceId: "mac2" }],
      ["x", { projectPath: "/Users/a/src/app", deviceId: "mac2" }],
    ]);
  });
});

describe("linking and attribution on one machine", () => {
  it("a local vault links and attributes only to the session on this machine", () => {
    const s = useInboxStore.getState();
    const place = vaultPlaceOf("local-app")!;
    expect(placeCandidates(s, place).map((r) => r._id)).toEqual(["here"]);
    expect(computeVaultAgentState(s, place, undefined, undefined, now).link).toEqual({ sessionId: "here", source: "folder" });
    expect(writerNow("local-app", "src/math.ts", now)).toBe("here");
  });

  it("the same path mirrored from the other Mac goes to the session there", () => {
    const s = useInboxStore.getState();
    expect(computeVaultAgentState(s, vaultPlaceOf(mirrorId)!, undefined, undefined, now).link.sessionId).toBe("there");
    expect(writerNow(mirrorId, "src/math.ts", now)).toBe("there");
    expect(writerNow(hostId, "src/math.ts", now)).toBe("there");
  });

  it("a pick or the conversation beside on another machine is not honored", () => {
    const s = useInboxStore.getState();
    expect(computeVaultAgentState(s, vaultPlaceOf("local-app")!, "there", undefined, now).link).toEqual({ sessionId: "here", source: "folder" });
  });

  it("with this window's machine unknown, a routed session is never linked or named", () => {
    useInboxStore.setState({ localDevice: null } as never);
    const s = useInboxStore.getState();
    expect(computeVaultAgentState(s, vaultPlaceOf("local-app")!, undefined, undefined, now).link.sessionId).toBeNull();
    expect(writerNow("local-app", "src/math.ts", now)).toBeNull();
  });
});

describe("the conversation beside Files", () => {
  const X = "x".repeat(32);
  const split = (...paths: string[]) => ({ type: "split", children: paths.map((path) => ({ type: "leaf", path })) });
  const other = { ...editing(X, "mac1", now), project_path: "/Users/a/src/other" };

  it("a conversation beside Files for another repo, on another tab, does not link this vault", () => {
    useInboxStore.setState((s) => ({
      sessions: { ...s.sessions, [X]: other },
      tabs: [
        { id: "t1", path: "/files", layout: { type: "leaf", path: "/files" } },
        { id: "t2", path: "/x", layout: split("/files", `/conversation/${X}`) },
      ],
      activeTabId: "t1",
    }) as never);
    const link = computeVaultAgentState(useInboxStore.getState(), vaultPlaceOf("local-app")!, undefined, undefined, now).link;
    expect(link).toEqual({ sessionId: "here", source: "folder" });
  });

  it("the conversation beside Files on the active tab links", () => {
    useInboxStore.setState((s) => ({
      sessions: { ...s.sessions, [X]: other },
      tabs: [{ id: "t1", path: "/x", layout: split("/files", `/conversation/${X}`) }],
      activeTabId: "t1",
    }) as never);
    expect(computeVaultAgentState(useInboxStore.getState(), vaultPlaceOf("local-app")!, undefined, undefined, now).link).toEqual({ sessionId: X, source: "beside" });
  });
});

describe("attribution by a bare file name", () => {
  const byName = { ...editing("here", "mac1", now), activity: { text: "Editing index.ts", tool: "Edit", at: now - 1000 } };
  const openTabs = (...paths: string[]) =>
    useCodeStore.setState((s) => ({ workspaces: { ...s.workspaces, "local-app": { groups: [{ id: "g", tabs: paths.map((path) => ({ path })), active: paths[0] }], activeGroup: "g", orientation: "horizontal", sizes: null, mru: [], closed: [] } } }));

  it("names the session only when no other open file shares the name", () => {
    useInboxStore.setState({ sessions: { here: byName }, messages: {} } as never);
    openTabs("src/a/index.ts");
    expect(writerNow("local-app", "src/a/index.ts", now)).toBe("here");
    openTabs("src/a/index.ts", "src/b/index.ts");
    expect(writerNow("local-app", "src/a/index.ts", now)).toBeNull();
    expect(writerNow("local-app", "src/b/index.ts", now)).toBeNull();
  });
});
