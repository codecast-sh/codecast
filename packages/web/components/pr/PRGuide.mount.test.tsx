import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "KeyboardEvent", "MouseEvent", "PointerEvent", "getComputedStyle", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

let row: any;
let authorGuide: any = null;
const prGuideHooks = await import("../../hooks/useSyncPrGuide");
mock.module("../../hooks/useSyncPrGuide", () => ({
  ...prGuideHooks,
  useSyncPrGuide: () => true,
  usePrGuide: () => row,
  useWritePrGuide: () => () => {},
}));
const evidenceHooks = await import("../../hooks/useSyncTaskEvidence");
mock.module("../../hooks/useSyncTaskEvidence", () => ({
  ...evidenceHooks,
  useSyncTaskEvidence: () => true,
  useTaskEvidence: () => (authorGuide ? { change_guide: authorGuide } : undefined),
}));
const { PRGuide } = await import("./PRGuide");

const PR = {
  _id: "pr1",
  number: 80,
  head_sha: "abc",
  files: [
    { filename: "scripts/base.sh", additions: 18, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
    { filename: "README.md", additions: 1, deletions: 1, patch: "@@ -1,1 +1,1 @@\n-x\n+y" },
  ],
};
const STEP = { title: "Pick the remote", why: "Everything reads it.", file: "scripts/base.sh", start: 1, end: 2, hunk: "@@ -0,0 +1,2 @@\n+a\n+b" };

let root: Root;
beforeEach(() => {
  authorGuide = null;
  row = { _id: "pr1", status: "ready", created_at: 1, steps: [STEP], summary: "", model: "claude-sonnet-5-5", head_sha: "abc", cost_usd: 0.03, finished_at: 1 };
  root = createRoot(document.getElementById("root")!);
});
afterEach(() => act(() => root.unmount()));

const draw = () => act(() => root.render(<MemoryRouter><PRGuide pr={PR} stepHref={(hash) => `/pr/o/r/80/files${hash}`} authed /></MemoryRouter>));
const rest = () => document.querySelector("[data-pr-guide-rest]");

test("a generated guide lists the changed files no step walks through, each opening its diff", async () => {
  await draw();
  expect(document.querySelector("[data-pr-guide='generated']")).not.toBeNull();
  expect(rest()?.getAttribute("data-pr-guide-rest")).toBe("1");
  expect(rest()?.textContent).toContain("Not in the guide · 1 file");
  const link = rest()!.querySelector("a")!;
  expect(link.textContent).toBe("README.md");
  expect(link.getAttribute("href")).toBe("/pr/o/r/80/files#diff-README.md");
  expect(rest()!.textContent).toContain("+1");
});

test("an author's guide lists them too, and a guide that walks every file lists nothing", async () => {
  authorGuide = { steps: [STEP], written_at: 1 };
  await draw();
  expect(document.querySelector("[data-pr-guide='author']")).not.toBeNull();
  expect(rest()?.getAttribute("data-pr-guide-rest")).toBe("1");

  authorGuide = { steps: [STEP, { ...STEP, title: "Docs", file: "README.md", start: 1, end: 1 }], written_at: 1 };
  await draw();
  expect(rest()).toBeNull();
});
