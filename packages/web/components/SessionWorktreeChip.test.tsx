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

test("a shared checkout row renders 'shared' with the main-checkout title; preparing still wins while pending (ct-49428)", () => {
  const shared = renderToStaticMarkup(<SessionWorktreeChip shared branch="codecast/cloud-abc123" hostName="Cloud Linux" />);
  expect(shared).toContain(">shared</span>");
  expect(shared).toContain("Runs on Cloud Linux\nRuns in the host&#x27;s main checkout (codecast/cloud-abc123)");
  expect(shared).not.toContain("Worktree");
  const pending = renderToStaticMarkup(<SessionWorktreeChip shared preparing hostName="Cloud Linux" />);
  expect(pending).toContain(">preparing</span>");
  expect(pending).toContain("Preparing the cloud host");
});

test("both compact worktree rows and full cards render the same location chip", () => {
  const source = readFileSync(new URL("./GlobalSessionPanel.tsx", import.meta.url), "utf8");
  const compact = source.indexOf("if (isSubagent) {");
  expect(compact).toBeGreaterThan(0);
  // The compact ↳ branch is gated on a REAL parent only. A worktree is a
  // location, not a parent: worktree_name must not appear anywhere in
  // SessionCard's branch decision (ct-49429).
  const card = source.slice(source.indexOf("export const SessionCard"), compact);
  expect(card).toContain("const isSubagent = !!subRow || !!session.is_subagent || !!nestParentIdOf(session);");
  expect(card).not.toContain("!!session.worktree_name");
  expect(source.slice(0, compact)).toContain('const worktreeChip = (session.worktree_name || session.cloud_placement === "pending" || session.cloud_workspace === "shared" || session.migration_batch_id)');
  expect(source.slice(compact).match(/\{worktreeChip\}/g)).toHaveLength(2);
  expect(source.slice(compact)).toContain('<div className="flex min-w-0 pl-[18px] mt-0.5">{worktreeChip}</div>');
  expect(source.slice(compact).indexOf("{worktreeChip}")).toBeGreaterThan(source.slice(compact).indexOf("{showBlockedBadge"));
});

test("a worktree does not make a first-class session look like a nested child", () => {
  const source = readFileSync(new URL("./GlobalSessionPanel.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const isSubagent =");
  expect(start).toBeGreaterThan(0);
  const line = source.slice(start, source.indexOf(";", start) + 1);
  expect(line).toContain("nestParentIdOf(session)");
  expect(line).not.toContain("worktree_name");
});

test("a placed cloud row says what it started from: `<name> @<base7>` and a 'Started from' title line, still no nested control (ct-49433)", () => {
  const base = "abc1234def0000000000000000000000000000000";
  const seeded = renderToStaticMarkup(<div role="button"><SessionWorktreeChip name="cloud-bc9163" branch="feat/x" hostName="Cloud Linux" seed={{ source: "checkout", base, branch: "feat/x", dirty: true }} /></div>);
  expect(seeded).toContain(">cloud-bc9163 @abc1234</span>");
  expect(seeded).toContain("Started from feat/x @ abc1234 + uncommitted changes");
  expect(seeded).toContain("Worktree cloud-bc9163 (feat/x)");
  expect(seeded).not.toContain("<button");
  const origin = renderToStaticMarkup(<SessionWorktreeChip name="cloud-aa1122" branch="codecast/cloud-aa1122" seed={{ source: "origin_main", base, reason: "host cast predates seeded worktrees" }} />);
  expect(origin).toContain(">cloud-aa1122 @abc1234</span>");
  expect(origin).toContain("Started from origin/main @ abc1234 — host cast predates seeded worktrees");
  // While still preparing there is no seed to show, even if a stale one rides the row.
  const pending = renderToStaticMarkup(<SessionWorktreeChip preparing hostName="Cloud Linux" seed={{ source: "checkout", base }} />);
  expect(pending).toContain(">preparing</span>");
  expect(pending).not.toContain("Started from");
});
