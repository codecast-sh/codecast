// The picker acts on the row that was highlighted when the person pressed
// Enter, even when activity re-sorts the rows under the highlight, and lists
// only sessions on the vault's machine.
import { installEditorDom } from "../../__tests__/editorDom";

installEditorDom();

const { afterAll, afterEach, beforeEach, describe, expect, it } = await import("bun:test");
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../../store/inboxStore");
const { useVaultStore } = await import("../../../../store/vaultStore");
const { useAgentStore } = await import("../../../../lib/code/agent/agentStore");
const { SessionPicker } = await import("../SessionPicker");

const inboxBefore = useInboxStore.getState();
const vaultBefore = useVaultStore.getState();
afterAll(() => {
  useInboxStore.setState(inboxBefore as never, true);
  useVaultStore.setState(vaultBefore as never, true);
});

const row = (id: string, title: string, at: number, device = "mac1") => ({ _id: id, title, agent_type: "claude_code", project_path: "/r/app", owner_device_id: device, updated_at: at, agent_status: "idle", is_idle: true });
const roots: Array<{ unmount(): void }> = [];
const picked: string[] = [];

beforeEach(() => {
  picked.length = 0;
  useInboxStore.setState({
    currentUser: { _id: "u1" },
    localDevice: { viewer: "u1", deviceId: "mac1" },
    tabs: [],
    sessions: { a: row("a", "Alpha", 20), b: row("b", "Beta", 10), far: row("far", "Other Mac", 99, "mac2") },
  } as never);
  useVaultStore.setState({ vaults: [{ id: "v", root: "/r/app", name: "app" }], remoteVaults: [] } as never);
  useAgentStore.setState({ links: {}, overrides: {}, picker: null, inline: null });
});
afterEach(() => act(() => roots.splice(0).forEach((r) => r.unmount())));

async function render() {
  const req = { vaultId: "v", anchor: null, action: "quote" as const, then: (id: string) => picked.push(id) };
  useAgentStore.getState().openPicker(req);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<SessionPicker request={req} root="/r/app" />));
  // Keys go to the filter, which has focus while the picker is open.
  const input = host.querySelector("input[aria-label='Filter sessions']") as HTMLInputElement;
  const press = (key: string, opts: KeyboardEventInit = {}) => act(() => void input.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts })));
  const type = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  const titles = () => [...host.querySelectorAll("[role=option]")].map((o) => o.textContent ?? "");
  const highlighted = () => host.querySelector("[aria-selected=true]")?.textContent ?? "";
  return { press, type, titles, highlighted };
}

describe("the session picker", () => {
  it("lists only this machine's sessions", async () => {
    const { titles } = await render();
    expect(titles().some((t) => t.includes("Alpha"))).toBe(true);
    expect(titles().some((t) => t.includes("Other Mac"))).toBe(false);
  });

  it("Enter sends to the highlighted session after the rows re-sort under it", async () => {
    const { press, highlighted, titles } = await render();
    expect(highlighted()).toContain("Alpha");
    press("ArrowDown");
    expect(highlighted()).toContain("Beta");
    // Beta's tool call moves it to the top while the picker is open.
    await act(async () => {
      useInboxStore.setState((s) => ({ sessions: { ...s.sessions, b: { ...row("b", "Beta", 30), activity: { text: "editing x.ts", tool: "Edit", at: 30 } } } }) as never);
    });
    expect(titles()[0]).toContain("Beta");
    expect(highlighted()).toContain("Beta");
    press("Enter");
    expect(picked).toEqual(["b"]);
    expect(useAgentStore.getState().overrides.v).toBe("b");
  });

  it("a highlighted session that leaves the list makes Enter do nothing", async () => {
    const { press } = await render();
    await act(async () => {
      useInboxStore.setState((s) => ({ sessions: { ...s.sessions, a: { ...row("a", "Alpha", 20), project_path: "/elsewhere" } } }) as never);
    });
    press("Enter");
    expect(picked).toEqual([]);
    expect(useAgentStore.getState().picker).not.toBeNull();
  });

  it("typing filters every session in the folder by title, past the recent cap, and Enter takes the best match", async () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, row(`s${i}`, `Session ${i}`, 100 + i)]));
    useInboxStore.setState((s) => ({ sessions: { ...s.sessions, ...many } }) as never);
    const { press, type, titles, highlighted } = await render();
    // Alpha (updated 20) is past the twelve most recent.
    expect(titles().some((t) => t.includes("Alpha"))).toBe(false);
    type("alp");
    expect(titles().filter((t) => !/New session|None/.test(t)).map((t) => t.includes("Alpha"))).toEqual([true]);
    expect(highlighted()).toContain("Alpha");
    // j and k are letters of the query, never moves.
    press("j");
    expect(highlighted()).toContain("Alpha");
    press("n", { ctrlKey: true });
    expect(highlighted()).toContain("New session");
    press("p", { ctrlKey: true });
    press("Enter");
    expect(picked).toEqual(["a"]);
  });
});
