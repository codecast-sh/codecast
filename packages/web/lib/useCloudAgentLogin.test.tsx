// The Connect Codex dialog's login hook: a sign-in that fails to start (the
// Codex CLI missing) must not stand for the answer once the person checks
// again, or the Sign in step never comes back; and opening the dialog asks
// the machine once.
// Run: cd packages/web && bun test lib/useCloudAgentLogin.test.tsx
import { test } from "bun:test";
import assert from "node:assert/strict";

test("check again after a failed sign-in start shows the machine's login, and the dialog checks once on open", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh/", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  const { act } = React;

  // Each enqueued command gets an id; its outcome is whatever the test sets for it.
  const sent: string[] = [];
  const outcomes = new Map<string, unknown>();
  const convexReact = await import("convex/react");
  mock.module("convex/react", () => ({
    ...convexReact,
    useMutation: () => async (args: { op: string }) => { sent.push(args.op); return { command_id: `cmd${sent.length}` }; },
    useQuery: (_ref: unknown, args: { command_id?: string } | "skip") => (args === "skip" ? undefined : outcomes.get(args.command_id!) ?? { state: "pending" }),
  }));

  const { useCloudAgentLogin } = await import("./useProviderKeyCommand");
  const device = { device_id: "dev1", label: "MacBook", online: true } as any;
  let hook!: ReturnType<typeof useCloudAgentLogin>;
  function Probe() {
    hook = useCloudAgentLogin("codex", device);
    return null;
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const render = async () => { await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(Probe))); }); };

  await render();
  await render();
  // Opened (under StrictMode's double effect run, and re-rendered): one check.
  assert.deepEqual(sent, ["check"]);
  outcomes.set("cmd1", { state: "done", login: "signed_out" });
  await render();
  assert.equal(hook.view.state, "signed_out");

  // Sign in, and the machine has no Codex CLI: the start fails and says why.
  await act(async () => { await hook.signIn(); });
  outcomes.set("cmd2", { state: "failed", error: "The Codex CLI isn't installed on this computer." });
  await render();
  assert.deepEqual(hook.view, { state: "failed", error: "The Codex CLI isn't installed on this computer." });

  // Installed, then "Check again": the new check's answer is the view, so signing in is offered again.
  await act(async () => { await hook.recheck(); });
  outcomes.set(`cmd${sent.length}`, { state: "done", login: "signed_out" });
  await render();
  assert.equal(hook.view.state, "signed_out");

  await act(async () => { root.unmount(); });

  // A header action runs on the same watched command: its result (and the pull request it opened) is heard once, then it lets go.
  const { useCloudAgentAction } = await import("./useProviderKeyCommand");
  const heard: unknown[] = [];
  let action!: ReturnType<typeof useCloudAgentAction>;
  function ActionProbe() {
    action = useCloudAgentAction("conv1", (outcome) => { heard.push(outcome); });
    return null;
  }
  const actionRoot = createRoot(document.getElementById("root")!);
  const renderAction = async () => { await act(async () => { actionRoot.render(React.createElement(ActionProbe)); }); };
  await renderAction();
  await act(async () => { await action.run("create_pr"); });
  assert.equal(action.pending, "create_pr");
  outcomes.set(`cmd${sent.length}`, { state: "done", detail: "Opened a draft pull request.", url: "https://github.com/o/r/pull/7" });
  await renderAction();
  await renderAction();
  assert.deepEqual(heard, [{ action: "create_pr", ok: true, text: "Opened a draft pull request.", url: "https://github.com/o/r/pull/7" }]);
  assert.equal(action.pending, null);
  await act(async () => { actionRoot.unmount(); });
});
