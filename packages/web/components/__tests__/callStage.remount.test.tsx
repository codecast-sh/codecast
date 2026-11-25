// THE STAGE KEEPS THE LAYOUT THE PERSON CHOSE ACROSS A SHRINK (ct-101326).
//
// Shrinking the call window to faces and expanding it again unmounts the
// stage and mounts a fresh one: CallPanel draws CallFaces for every size but
// "panel" (CallPanel.tsx), and the voice host draws the stage only in its
// "panel" view (VoiceHostPanel.tsx). The thread rail the person opened and the
// view they picked (auto / speaker / grid) must come back with the stage, not
// reset to closed and auto.
//
// The real stage, mounted over a backend that answers nothing
// (test-helpers/missingBackend.tsx), in a connected call.
// Run: cd packages/web && bun test --isolate components/__tests__/callStage.remount.test.tsx
import { expect, test } from "bun:test";
import { installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

const { mountSurface } = installDom("https://app.test/call-panel?room=dm:a:b");
await installMissingBackend();
await seedViewer();

const React = await import("react");
const act: <T>(cb: () => T | Promise<T>) => Promise<T> = (React as any).act;
const { useInboxStore } = await import("../../store/inboxStore");
const { CallStage } = await import("../calls/CallStage");
const { MemoryRouter } = await import("react-router");
const stage = () => (
  <MemoryRouter initialEntries={["/call-panel"]}>
    <CallStage panel onShrink={() => {}} />
  </MemoryRouter>
);

useInboxStore.setState({ call: { ...useInboxStore.getState().call, phase: "connected", roomKey: "dm:a:b" } } as any);

// The stage is portaled to the body, so it is read off the document.
const threadButton = (c: ParentNode = document) =>
  [...c.querySelectorAll("button")].find((b) => /^(Open|Close) the thread/.test(b.getAttribute("aria-label") ?? "")) as HTMLButtonElement | undefined;
const viewRadio = (key: string, c: ParentNode = document) =>
  [...c.querySelectorAll('[role=radiogroup][aria-label="View"] [role=radio]')].find((r) => r.textContent?.trim() === key) as HTMLElement | undefined;
const click = (el: Element) => act(async () => void el.dispatchEvent(new (window as any).MouseEvent("click", { bubbles: true })));

test("the thread rail and the view survive the stage folding to faces and back", async () => {
  // The stage as the person sets it up: thread open, grid view.
  const first = await mountSurface(stage());
  const open = threadButton();
  expect(open?.getAttribute("aria-label")).toStartWith("Open the thread");
  await click(open!);
  await click(viewRadio("grid")!);
  expect(threadButton()?.getAttribute("aria-label")).toStartWith("Close the thread");
  expect(viewRadio("grid")?.getAttribute("aria-checked")).toBe("true");

  // Shrink: the window draws faces and the stage goes. Expand: a stage again.
  await first.unmount();
  const second = await mountSurface(stage());
  try {
    // One stage on the page, the new one, with its controls drawn.
    expect(document.querySelectorAll(".call-stage").length).toBe(1);
    expect(threadButton()).toBeDefined();
    expect(viewRadio("grid")).toBeDefined();
    expect({
      thread: threadButton()?.getAttribute("aria-label")?.startsWith("Close the thread") ? "open" : "closed",
      view: viewRadio("grid")?.getAttribute("aria-checked") === "true" ? "grid" : "not grid",
    }).toEqual({ thread: "open", view: "grid" });
  } finally {
    await second.unmount();
  }
}, 120_000);
