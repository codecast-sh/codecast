import { expect, test } from "bun:test";
import { join } from "node:path";

test("the label picker accepts a deferred blank session", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/blankSessionLabelPicker.tsx")], {
    cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr: code ? stderr : "", stdout }).toMatchObject({ code: 0 });
  expect(stdout).toContain("PASS: a real label-picker click");
}, 90000);
