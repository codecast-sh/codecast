import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { SessionWorktreeChip } from "./SessionWorktreeChip";

test("cloud worktree exposes host and branch without adding a nested control", () => {
  const html = renderToStaticMarkup(<div role="button"><SessionWorktreeChip name="cloud-bc9163" branch="codecast/cloud-bc9163" hostName="Cloud Linux" hostIcon={<svg />} /></div>);
  expect(html).toContain("Runs on Cloud Linux");
  expect(html).toContain("Worktree cloud-bc9163 (codecast/cloud-bc9163)");
  expect(html).toContain(">cloud-bc9163</span>");
  expect(html).toContain("<svg");
  expect(html).toContain('<span class="sr-only">Runs on Cloud Linux\nWorktree cloud-bc9163 (codecast/cloud-bc9163)</span>');
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain("<button");
  expect(html).not.toContain("data-simple-hide");
});

test("local worktree and pending placement remain truthful", () => {
  const local = renderToStaticMarkup(<SessionWorktreeChip name="local-a" />);
  expect(local).toContain("Worktree local-a");
  expect(local).not.toContain("Runs on");
  const pending = renderToStaticMarkup(<SessionWorktreeChip preparing hostName="Cloud Linux" />);
  expect(pending).toContain("Preparing the cloud host");
  expect(pending).toContain(">preparing</span>");
  expect(renderToStaticMarkup(<SessionWorktreeChip />)).toBe("");
});

test("both compact worktree rows and full cards render the same location chip", () => {
  const source = readFileSync(new URL("./GlobalSessionPanel.tsx", import.meta.url), "utf8");
  const compact = source.indexOf("if (isSubagent) {");
  expect(compact).toBeGreaterThan(0);
  expect(source.slice(0, compact)).toContain('const worktreeChip = (session.worktree_name || session.cloud_placement === "pending")');
  expect(source.slice(compact).match(/\{worktreeChip\}/g)).toHaveLength(2);
  expect(source.slice(compact)).toContain('<div className="flex min-w-0 pl-[18px] mt-0.5">{worktreeChip}</div>');
  expect(source.slice(compact).indexOf("{worktreeChip}")).toBeGreaterThan(source.slice(compact).indexOf("{showBlockedBadge"));
});
