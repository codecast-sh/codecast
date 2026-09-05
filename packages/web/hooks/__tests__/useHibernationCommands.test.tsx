import { expect, test } from "bun:test";

test("hibernation commands preserve real subscriptions and handler/outbox behavior in isolation", async () => {
  const child = Bun.spawn([process.execPath, "--no-env-file", "test", `${import.meta.dir}/fixtures/useHibernationCommands.tsx`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("13 pass");
  expect(stderr).toContain("80 expect() calls");
}, 30_000);

test("TmuxAttachPill module mocks cannot replace hibernation subscriptions", async () => {
  const child = Bun.spawn([
    process.execPath, "--no-env-file", "test",
    `${import.meta.dir}/../../components/TmuxAttachPill.degrade.test.tsx`, import.meta.path,
    "--test-name-pattern", "TmuxAttachPill under|hibernation commands preserve",
  ], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("5 pass");
}, 30_000);
