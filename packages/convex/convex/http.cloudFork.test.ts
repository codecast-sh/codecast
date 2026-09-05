import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the CLI fork route forwards placement to the fork mutation", () => {
  const source = readFileSync(new URL("./http.ts", import.meta.url), "utf8");
  const route = source.slice(source.indexOf('path: "/cli/fork"'));
  const mutation = route.slice(route.indexOf("ctx.runMutation("), route.indexOf("return new Response(JSON.stringify(result)"));
  for (const field of ["cloud_device_id", "cloud_project_path", "cloud_worktree"]) {
    expect(mutation).toContain(`${field}: body.${field}`);
  }
});
