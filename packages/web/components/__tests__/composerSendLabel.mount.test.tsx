// The composer's send button says what the send does when the batch holds
// proposal answers (org-staffing.md S39): with a label it is a violet pill
// reading "Send and apply 3"; without one it is the icon as today; the bare
// comment box ignores the label.
import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    // The pill is as wide as its words: a height and padding, never a fixed width (jsdom lays nothing out, so the classes stand in for the box).
    expect(b.className).toContain("h-8");
    expect(b.className).toContain("px-3");
    expect(b.className).toContain("whitespace-nowrap");
    expect(b.className).not.toMatch(/(^|\s)(w-\d|w-\[|aspect-)/);
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

// The hosted-mode stylesheet draws the icon send as a 40px disc with a rule on
// [data-cc-send] that outranks the pill's classes; it once clipped "Send and
// apply 15" to "Senc". Every rule that sizes [data-cc-send] must leave the
// labelled form out.
test("the stylesheet's round send rules are scoped to the icon form", () => {
  const css = readFileSync(join(import.meta.dir, "../../app/globals.css"), "utf8");
  const sizing: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim(), body = m[2];
    if (!selector.includes("[data-cc-send]") || !/(^|;|\s)(width|height|min-width|aspect-ratio)\s*:/.test(body)) continue;
    sizing.push(selector);
    for (const part of selector.split(",")) expect(part.trim()).toContain("[data-cc-send]:not([data-cc-send-label])");
  }
  expect(sizing.length).toBeGreaterThan(0);
});
