import { expect, test } from "bun:test";
import { runHibernationChild } from "./fixtures/runHibernationChild";

test("hibernation commands preserve real subscriptions and handler/outbox behavior in isolation", async () => {
  const { code, stdout, stderr } = await runHibernationChild(["test", `${import.meta.dir}/fixtures/useHibernationCommands.tsx`], 20_000);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("13 pass");
  expect(stderr).toContain("80 expect() calls");
}, 24_000);

test("TmuxAttachPill module mocks cannot replace hibernation subscriptions", async () => {
  const { code, stdout, stderr } = await runHibernationChild([
    "test",
    `${import.meta.dir}/../../components/TmuxAttachPill.degrade.test.tsx`, import.meta.path,
    "--test-name-pattern", "TmuxAttachPill under|hibernation commands preserve",
  ], 27_000);
  expect({ code, stdout, stderr }).toMatchObject({ code: 0 });
  expect(stderr).toContain("5 pass");
}, 30_000);

test("a hanging nested child is killed before its parent deadline and leaves no surviving process", async () => {
  const helper = `${import.meta.dir}/fixtures/runHibernationChild.ts`;
  const hang = "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);";
  const outer = await runHibernationChild(["-e", `
    import { runHibernationChild } from ${JSON.stringify(helper)};
    console.log(JSON.stringify(await runHibernationChild(["-e", ${JSON.stringify(hang)}], 6_000)));
  `], 6_000);
  expect(outer).toMatchObject({ code: 0, signalCode: null, stderr: "" });
  const inner = JSON.parse(outer.stdout);
  expect(inner.signalCode).toBe("SIGKILL");
  expect(inner.code).not.toBe(0);
  expect(Number(inner.stdout.trim())).toBe(inner.pid);
  expect(outer.deadlineMs - inner.deadlineMs).toBe(2_000);
  for (const pid of [inner.pid, outer.pid]) {
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }
}, 10_000);
