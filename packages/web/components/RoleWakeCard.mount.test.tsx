// Mounts the wake card in jsdom against the fixture frame and checks what the
// reader sees: the role's name and handle linking to its page, the wake id and
// the cause count, the held tag, Why open and every other section folded with
// its line count, "show all N lines" past the cap, and the footer controls
// (pause only for an editor, resume when paused, the caps and wake log links).
// Run: bun components/RoleWakeCard.mount.test.tsx
import assert from "node:assert/strict";

async function mountCard() {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
  for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "HTMLButtonElement", "Element", "Node", "NodeFilter", "MutationObserver", "CustomEvent", "Event", "getComputedStyle"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { mock } = await import("bun:test");
  const React = await import("react");
  // The markdown pipeline drags the pill resolver and the store; the card only
  // hands it each line. Render the line's text, so an id stays visible.
  mock.module("react-markdown", () => ({ default: ({ children }: { children: string }) => React.createElement("span", { "data-md": true }, children) }));
  mock.module("./messageMarkdown", () => ({ MESSAGE_MD_REHYPE: [], MESSAGE_MD_COMPONENTS: {} }));
  mock.module("../lib/remarkEntityIds", () => ({ entityRemarkPlugins: [] }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => React.createElement("a", { href, ...rest }, children) }));
  const { act } = React;
  const { createRoot } = await import("react-dom/client");
  const { RoleWakeCard } = await import("./RoleWakeCard");
  const { parseRoleWakeFrame, ROLE_WAKE_LINE_CAP } = await import("./roleWake");
  const { ROLE_WAKE_FIXTURE } = await import("./roleWakeFixture");
  const frame = parseRoleWakeFrame(ROLE_WAKE_FIXTURE)!;
  assert.ok(frame);
  const root = createRoot(document.getElementById("root")!);
  const calls: boolean[] = [];
  const role: any = { _id: "role8", short_id: "or-8", name: "Reliability lead", handle: "reliability", status: "active", host_user_id: "u1" };
  const render = (props: Partial<Parameters<typeof RoleWakeCard>[0]> = {}) =>
    act(() => {
      root.render(React.createElement(RoleWakeCard, { frame, now: frame.at! + 5 * 60_000, role, canEdit: true, onSetPaused: (p: boolean) => calls.push(p), ...props }));
    });
  await render();
  const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
  const $$ = (sel: string) => Array.from(document.querySelectorAll(sel)) as HTMLElement[];
  const text = () => document.body.textContent ?? "";
  return { React, act, render, frame, role, calls, $, $$, text, ROLE_WAKE_LINE_CAP, root, dom };
}

async function verifyRoleWakeCard() {
    const { act, render, frame, role, calls, $, $$, text, ROLE_WAKE_LINE_CAP, root, dom } = await mountCard();

    // Header: who, which wake, why, when.
    const roleLink = $$("a").find((a) => a.getAttribute("href") === "/org/or-8" && a.textContent?.includes("Reliability lead"));
    assert.ok(roleLink, "the role name links to its page");
    assert.ok(roleLink.textContent?.includes("@reliability"));
    const wakeLink = $$("a").find((a) => a.textContent?.trim() === "rw-12");
    assert.ok(wakeLink, "the wake id is shown");
    assert.equal(wakeLink.getAttribute("href"), "/org/or-8?tab=wakes&wake=rw-12");
    assert.ok(text().includes("woke on 9 changes, 2 held"));
    assert.ok(text().includes("held backlog"));
    assert.ok(text().includes("5m"), "age from the frame's at");
    assert.ok(text().includes("trust understand · 1/40 wakes"));

    // Sections: Why open, the rest folded, each with its count.
    const groups = $$("[data-section]");
    assert.deepEqual(groups.map((g) => g.dataset.section), ["you", "why", "scope", "hands", "channels", "charter"]);
    const expanded = groups.map((g) => g.querySelector("button")!.getAttribute("aria-expanded"));
    assert.deepEqual(expanded, ["false", "true", "false", "false", "false", "false"]);
    assert.ok(groups[1].textContent?.includes("8 lines"));
    assert.ok(groups[2].textContent?.includes("11 lines"));
    assert.ok(groups[5].textContent?.includes("1 line"));
    // Why's lines render (through the markdown mock) with their ids; the held
    // and passive marks are tags, not text.
    const why = groups[1];
    assert.ok(why.textContent?.includes('ct-51321 "Investigate repeated iOS crashes'));
    assert.ok(!why.textContent?.includes("(held)"));
    assert.equal(why.querySelectorAll("[data-md]").length, 8);
    assert.ok(why.textContent?.includes("held"));
    assert.ok(why.textContent?.includes("passive"));
    // The scope section is folded: nothing of its body is in the DOM yet.
    assert.ok(!text().includes("Tasks: 164 in scope"));
    await act(() => { groups[2].querySelector("button")!.click(); });
    assert.ok(text().includes("Tasks: 164 in scope"));
    // A label line reads as a subhead: "Plans:" loses its colon.
    assert.ok(groups[2].textContent?.includes("Plans"));
    assert.ok(!groups[2].textContent?.includes("Plans:"));

    // The line cap: a long section shows the cap then "show all N lines".
    const long = { ...frame, sections: [{ key: "why" as const, title: "Why you are awake", lines: Array.from({ length: 30 }, (_, i) => `- task ct-${i} is open`) }] };
    await render({ frame: long });
    assert.equal($$("[data-md]").length, ROLE_WAKE_LINE_CAP);
    const more = $$("button").find((b) => b.textContent === "show all 30 lines");
    assert.ok(more);
    await act(() => { more.click(); });
    assert.equal($$("[data-md]").length, 30);
    await render();

    // Footer: open role, pause (an editor), caps, the wake log.
    const footerLinks = $$("a").map((a) => [a.textContent?.trim(), a.getAttribute("href")]);
    assert.ok(footerLinks.some(([t, h]) => t === "Open role" && h === "/org/or-8"));
    assert.ok(footerLinks.some(([t, h]) => t === "Caps" && h === "/org/or-8?tab=settings"));
    assert.ok(footerLinks.some(([t, h]) => t === "Why did this wake me" && h === "/org/or-8?tab=wakes&wake=rw-12"));
    const pause = $$("button").find((b) => b.textContent?.trim() === "Pause");
    assert.ok(pause, "an editor sees Pause");
    await act(() => { pause.click(); });
    assert.deepEqual(calls, [true]);

    // Paused: the header says so and the control flips to Resume.
    await render({ role: { ...role, status: "paused" } });
    assert.ok(text().includes("paused now"));
    const resume = $$("button").find((b) => b.textContent?.trim() === "Resume");
    assert.ok(resume);
    await act(() => { resume.click(); });
    assert.deepEqual(calls, [true, false]);

    // A viewer without the right sees no pause; a cold tree still names the
    // role from the frame's You line.
    await render({ canEdit: false });
    assert.ok(!$$("button").some((b) => /^(Pause|Resume)$/.test(b.textContent?.trim() ?? "")));
    await render({ role: null, canEdit: false });
    assert.ok(text().includes("Reliability lead"));
    assert.ok(text().includes("@reliability"));
    assert.ok(!$$("button").some((b) => /^(Pause|Resume)$/.test(b.textContent?.trim() ?? "")));
    assert.ok($("[data-role-wake='or-8']"));

    await act(() => root.unmount());
    dom.window.close();
    console.log("role wake card mount: passed");
}

if (import.meta.main) await verifyRoleWakeCard();
