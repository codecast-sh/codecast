import { expect, test } from "bun:test";

test("integration project links navigate the active tab and preserve modified clicks", async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/fixtures/issueSyncNavigation.tsx`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout).toContain("project navigation scenarios passed");
}, 30_000);
