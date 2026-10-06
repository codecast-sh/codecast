// The composer's send button says what the send does when the batch holds
// proposal answers (org-staffing.md S39): with a label it is a violet pill
// reading "Send and apply 3"; without one it is the icon as today; the bare
// comment box ignores the label.
import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { ComposerSendButton } = await import("../ComposerShell");
afterAll(() => { dom.window.close(); restore(); });

const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button")!;

test("a label makes the send a violet pill that says what it applies; without one the icon stands; bare ignores it", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() => root.render(<ComposerSendButton canSubmit label="Send and apply 3" />));
    let b = button(host);
    expect(b.textContent?.trim()).toBe("Send and apply 3");
    expect(b.getAttribute("aria-label")).toBe("Send and apply 3");
    expect(b.dataset.ccSendLabel).toBe("Send and apply 3");
    expect(b.hasAttribute("data-cc-send")).toBe(true);
    expect(b.className).toContain("bg-[var(--sol-violet)]");
    expect(b.className).toContain("text-[var(--sol-bg)]");
    expect(b.className).toContain("rounded-full");
    expect(b.disabled).toBe(false);
    expect(b.querySelector("svg")).not.toBeNull();
    // Held: the same pill, faded.
    await act(() => root.render(<ComposerSendButton canSubmit={false} label="Send 2 answers" title="Out of allowance" />));
    b = button(host);
    expect(b.disabled).toBe(true);
    expect(b.className).toContain("opacity-[0.45]");
    expect(b.title).toBe("Out of allowance");
    expect(b.textContent?.trim()).toBe("Send 2 answers");
    // No label: the icon, named Send, no label hook.
    await act(() => root.render(<ComposerSendButton canSubmit />));
    b = button(host);
    expect(b.textContent?.trim()).toBe("");
    expect(b.getAttribute("aria-label")).toBe("Send");
    expect(b.dataset.ccSendLabel).toBeUndefined();
    expect(b.hasAttribute("data-cc-send")).toBe(true);
    expect(b.className).not.toContain("--sol-violet");
    // Quotes only keeps its cyan tint.
    await act(() => root.render(<ComposerSendButton canSubmit quotesOnly />));
    expect(button(host).className).toContain("sol-cyan");
    // The bare comment box ignores the label.
    await act(() => root.render(<ComposerSendButton canSubmit bare label="Send and apply 3" />));
    b = button(host);
    expect(b.textContent?.trim()).toBe("");
    expect(b.getAttribute("aria-label")).toBe("Send");
    expect(b.hasAttribute("data-cc-send")).toBe(false);
    expect(b.className).toContain("w-6");
  } finally { await act(() => root.unmount()); host.remove(); }
}, 60_000);
