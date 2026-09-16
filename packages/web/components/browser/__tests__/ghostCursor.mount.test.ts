import { expect, test } from "bun:test";
import { join } from "node:path";

// The fixture mocks modules (convex, the terminal endpoint) and installs a
// fake WebSocket, so it runs in its own process; see fixtures/ghostCursor.tsx.
test("an action frame on the watch socket moves the ghost cursor", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/ghostCursor.tsx")], {
    cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr: code ? stderr : "", stdout }).toMatchObject({ code: 0 });
  expect(stdout).toContain("PASS: action frames move the ghost cursor");
}, 90000);
