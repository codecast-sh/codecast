// The Cmd-K box against stubbed store sends: Enter sends exactly one message to
// the session pinned when the box opened (never the link as it is now), empty
// text sends nothing, Escape cancels, no target asks first and sends on the
// pick, and the typed text survives CodeMirror drawing the widget again.
import { installEditorDom } from "../../__tests__/editorDom";

installEditorDom();

const { afterAll, afterEach, beforeEach, describe, expect, it } = await import("bun:test");
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../../../../store/inboxStore");
const { useAgentStore } = await import("../../../../lib/code/agent/agentStore");
const { instructionMessage } = await import("../../../../lib/code/agent/compose");
const { InlineInstruction } = await import("../InlineInstruction");

const inboxBefore = useInboxStore.getState();
afterAll(() => useInboxStore.setState(inboxBefore as never, true));

const range = { absPath: "/r/app/src/math.ts", startLine: 4, endLine: 4, code: "  return a + b;", lang: "ts", context: { linesFrom: 4, lines: ["  return a + b;"] } };
const sends: unknown[][] = [];
const events: string[] = [];
const roots: Array<{ unmount(): void }> = [];

beforeEach(() => {
  sends.length = 0;
  events.length = 0;
  useInboxStore.setState({
    sessions: {
      s1: { _id: "s1", title: "Fix the parser", agent_type: "claude_code", updated_at: 1 },
      s2: { _id: "s2", title: "Other work", agent_type: "codex", updated_at: 2 },
    },
    addOptimisticMessage: (id: string, text: string) => {
      sends.push(["optimistic", id, text]);
      return `client-${sends.length}`;
    },
    sendMessageWhenReady: (...args: unknown[]) => sends.push(["send", ...args]),
  } as never);
  useAgentStore.setState({ links: {}, picker: null, inline: null });
});
afterEach(() => act(() => roots.splice(0).forEach((r) => r.unmount())));

function open(sessionId: string | null) {
  useAgentStore.getState().openInline({
    vaultId: "v",
    sessionId,
    range,
    onSent: (id, clientId) => events.push(`sent:${id}:${clientId}`),
    onClose: () => events.push("closed"),
  });
  return useAgentStore.getState().inline!;
}

async function render(req = useAgentStore.getState().inline!) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(<InlineInstruction request={req} />));
  return { host, box: host.querySelector("textarea")!, root };
}

function type(box: HTMLTextAreaElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    set.call(box, text);
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

const press = (box: HTMLTextAreaElement, key: string) => act(() => void box.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

describe("the inline instruction box", () => {
  it("names its target and sends ONE message there on Enter, even after the folder link moved", async () => {
    useAgentStore.getState().setLink("v", { sessionId: "s1", source: "folder" });
    open("s1");
    const { host, box } = await render();
    expect(host.textContent).toContain("Fix the parser");
    // The folder link re-ranks while the person types.
    act(() => useAgentStore.getState().setLink("v", { sessionId: "s2", source: "folder" }));
    type(box, "use checked addition");
    press(box, "Enter");
    const text = instructionMessage(range, "use checked addition");
    expect(sends).toEqual([
      ["optimistic", "s1", text],
      ["send", "s1", text, undefined, "client-1"],
    ]);
    expect(events).toEqual(["sent:s1:client-1"]);
    expect(useAgentStore.getState().inline).toBeNull();
  });

  it("sends nothing for empty text, and Escape cancels", async () => {
    open("s1");
    const { box } = await render();
    type(box, "   ");
    press(box, "Enter");
    expect(sends).toEqual([]);
    expect(useAgentStore.getState().inline).not.toBeNull();
    press(box, "Escape");
    expect(sends).toEqual([]);
    expect(events).toEqual(["closed"]);
    expect(useAgentStore.getState().inline).toBeNull();
  });

  it("with no target, Enter asks for a session and the pick sends", async () => {
    open(null);
    const { host, box } = await render();
    expect(host.textContent).toContain("Pick a session");
    type(box, "explain this");
    press(box, "Enter");
    expect(sends).toEqual([]);
    const picker = useAgentStore.getState().picker!;
    expect(picker.action).toBe("instruct");
    act(() => picker.then!("s2"));
    expect(sends.map((x) => [x[0], x[1]])).toEqual([
      ["optimistic", "s2"],
      ["send", "s2"],
    ]);
    expect(events).toEqual(["sent:s2:client-1"]);
  });

  it("keeps the typed text when the widget is drawn again", async () => {
    const req = open("s1");
    const first = await render(req);
    type(first.box, "line one\nline two");
    act(() => first.root.unmount());
    roots.splice(roots.indexOf(first.root), 1);
    const again = await render(req);
    expect(again.box.value).toBe("line one\nline two");
    expect(again.box.getAttribute("rows")).toBe("2");
  });
});
