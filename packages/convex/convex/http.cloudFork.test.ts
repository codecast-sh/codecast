import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the CLI fork route forwards placement to the fork mutation", () => {
  const source = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf('path: "/cli/fork"'));
  const mutation = route.slice(route.indexOf("ctx.runMutation("), route.indexOf("return new Response(JSON.stringify(result)"));
  for (const field of ["cloud_device_id", "cloud_project_path", "cloud_worktree", "cloud_seed"]) {
    expect(mutation).toContain(`${field}: body.${field}`);
  }
});

test("a cloud fork's row is stamped isolated beside its seed (the worktree is the fork's own)", () => {
  const source = readFileSync(new URL("./conversations.ts", import.meta.url), "utf8");
  const start = source.indexOf("worktree_name: args.cloud_worktree?.name");
  const insert = source.slice(start, source.indexOf('fork_status: "copying"', start));
  expect(insert).toContain('...(args.cloud_worktree ? { cloud_workspace: "isolated" as const } : {})');
  expect(insert).toContain("...(args.cloud_seed ? { cloud_seed: { ...args.cloud_seed, at: now } } : {})");
});
