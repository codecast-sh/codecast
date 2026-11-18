// The trigger form for a trigger the viewer does not own (ct-95585 review):
// what it runs (prompt, agent, read-only, checkout) is locked, so the form
// never offers a change the server refuses; the title and the schedule stay
// the viewer's to change. The owner's form is unlocked.
import { expect, test } from "bun:test";
import { installModernDom } from "../../test-helpers/modernDom";

installModernDom("https://app.test/triggers");

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { offlineConvexClient } = await import("../../test-helpers/offlineConvex");
const { useInboxStore } = await import("../../store/inboxStore");
const { TriggerForm } = await import("./page");

const convex = offlineConvexClient();
const trigger = { _id: "tr1", short_id: "tr-1", user_id: "users_samvit", title: "Daily sweep", prompt: "Sweep", schedule_type: "recurring", interval_ms: 86_400_000, status: "scheduled", agent_type: "grok", mode: "apply", project_path: "/repo" };

async function formFor(viewer: string) {
  useInboxStore.setState({ currentUser: { _id: viewer } } as any);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/triggers"]}><TriggerForm editTask={trigger} onClose={() => {}} /></MemoryRouter>
    </ConvexProvider>,
  ));
  const q = (sel: string) => host.querySelector(sel) as HTMLInputElement | null;
  const agentButtons = [...host.querySelectorAll("button")].filter((b) => ["claude", "codex"].includes(b.textContent?.trim() ?? ""));
  return {
    prompt: q("textarea"),
    title: q('input[placeholder^="Optional: named"]'),
    project: q('input[list="trigger-project-roots"]'),
    readOnly: q('input[type="checkbox"]'),
    agentButtons,
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

test("a teammate's form locks what the trigger runs and leaves its title open", async () => {
  const f = await formFor("users_mate");
  expect(f.prompt!.disabled).toBe(true);
  expect(f.project!.disabled).toBe(true);
  expect(f.readOnly!.disabled).toBe(true);
  expect(f.agentButtons.length).toBe(2);
  // The shared toggle marks a locked option aria-disabled and ignores its press.
  for (const b of f.agentButtons) expect(b.getAttribute("aria-disabled")).toBe("true");
  const codex = f.agentButtons.find((b) => b.textContent?.trim() === "codex")!;
  await act(async () => (codex as HTMLButtonElement).click());
  expect(f.agentButtons.find((b) => b.textContent?.trim() === "claude")!.getAttribute("aria-pressed")).toBe("true");
  expect(f.prompt!.getAttribute("title")).toBe("Only its owner can change this");
  expect(f.title!.disabled).toBe(false);
  await f.unmount();
});

test("the owner's form is unlocked", async () => {
  const f = await formFor("users_samvit");
  expect(f.prompt!.disabled).toBe(false);
  expect(f.project!.disabled).toBe(false);
  expect(f.readOnly!.disabled).toBe(false);
  for (const b of f.agentButtons) expect(b.getAttribute("aria-disabled")).toBeNull();
  await f.unmount();
});
