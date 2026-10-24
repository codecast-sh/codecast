// The permission card answers with more than a keystroke: a denial can carry
// a reason for the model, and "Always allow" keeps the rule Claude suggested,
// named on the button.
import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";
import { permissionRuleLabels } from "../PermissionCard";
import { oldestBlocked } from "../../lib/decisionQueue";

const RULE = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "bun test:*" }], behavior: "allow", destination: "localSettings" };

describe("permissionRuleLabels", () => {
  test("names rules the way Claude's settings write them", () => {
    expect(permissionRuleLabels([
      RULE,
      { type: "addRules", rules: [{ toolName: "WebFetch" }], behavior: "allow" },
      { type: "addDirectories", directories: ["/tmp/x"] },
      { type: "setMode", mode: "acceptEdits" },
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "deny" },
      null,
    ])).toEqual(["Bash(bun test:*)", "WebFetch", "/tmp/x", "mode: acceptEdits"]);
    expect(permissionRuleLabels(undefined)).toEqual([]);
  });
});

describe("oldestBlocked", () => {
  test("picks the longest-blocked session and ignores the rest", () => {
    const s = (id: string, status: string, at?: number) => ({ _id: id, agent_status: status, agent_status_updated_at: at });
    expect(oldestBlocked([s("a", "permission_blocked", 30), s("b", "idle", 1), s("c", "permission_blocked", 10)])?._id).toBe("c");
    expect(oldestBlocked([s("a", "working", 1)])).toBeUndefined();
  });
});

async function dom() {
  const { JSDOM } = await import("jsdom");
  const d = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/", pretendToBeVisual: true });
  const w = d.window as any;
  const restore = replaceGlobals({
    window: w, document: w.document, navigator: w.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    HTMLElement: w.HTMLElement, HTMLInputElement: w.HTMLInputElement, Element: w.Element, Node: w.Node, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle.bind(w),
    DocumentFragment: w.DocumentFragment, KeyboardEvent: w.KeyboardEvent, Event: w.Event, CustomEvent: w.CustomEvent, NodeFilter: w.NodeFilter,
    localStorage: w.localStorage, requestAnimationFrame: (f: any) => setTimeout(f, 0), cancelAnimationFrame: clearTimeout,
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(w.document.getElementById("root"));
  const q = <T extends Element = HTMLElement>(sel: string) => w.document.querySelector(sel) as T | null;
  const buttons = () => [...w.document.querySelectorAll("button")] as HTMLButtonElement[];
  const press = (label: string) => React.act(async () => buttons().find((b) => b.textContent === label)!.click());
  const render = (el: any) => React.act(async () => root.render(el));
  const type = (value: string) => React.act(async () => {
    const input = q<HTMLInputElement>("input")!;
    Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
  });
  const submit = () => React.act(async () => { q<HTMLFormElement>("form")!.requestSubmit(); });
  const done = async () => { await React.act(async () => root.unmount()); await React.act(async () => { await new Promise((r) => setTimeout(r, 10)); }); restore(); };
  return { React, q, buttons, press, render, type, submit, done };
}

test("Deny opens a reason field; the reason goes with the denial", async () => {
  const { React, q, press, render, type, submit, done } = await dom();
  try {
    const { PermissionStackView } = await import("../PermissionCard");
    const calls: Array<[string, string | undefined]> = [];
    const pending = [{ _id: "p1", tool_name: "Bash", arguments_preview: "bun test", status: "pending" as const }];
    await render(React.createElement(PermissionStackView, {
      pending, inflight: new Set<string>(), onApprove: () => {}, onDeny: (id: string, m?: string) => calls.push([id, m]),
      onApproveAll: () => {}, onDenyAll: () => {},
    }));
    assert.equal(q("[data-always-allow]"), null, "no suggestions, nothing to always allow");
    await press("Deny");
    assert.deepEqual(calls, [], "the first press only opens the reason");
    await type("  run one file only ");
    await submit();
    assert.deepEqual(calls, [["p1", "run one file only"]]);
  } finally { await done(); }
}, 120_000);

test("Always allow names the suggested rule and answers with it", async () => {
  const { React, q, render, done } = await dom();
  try {
    const { PermissionStackView } = await import("../PermissionCard");
    const calls: string[] = [];
    const pending = [
      { _id: "p1", tool_name: "Bash", arguments_preview: "bun test", status: "pending" as const, suggestions: [RULE] },
      { _id: "p2", tool_name: "Read", arguments_preview: "/x", status: "pending" as const },
    ];
    await render(React.createElement(PermissionStackView, {
      pending, inflight: new Set<string>(), onApprove: () => {}, onDeny: () => {}, onAlwaysAllow: (id: string) => calls.push(id),
      onApproveAll: () => {}, onDenyAll: () => {},
    }));
    const btn = q("[data-always-allow]")!;
    assert.equal(btn.textContent, "Always allow Bash(bun test:*)");
    assert.equal(document.querySelectorAll("[data-always-allow]").length, 1, "only the row with a suggestion offers it");
    await React.act(async () => btn.click());
    assert.deepEqual(calls, ["p1"]);
  } finally { await done(); }
}, 120_000);
