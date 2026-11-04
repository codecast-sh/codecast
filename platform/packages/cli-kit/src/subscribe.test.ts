import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { check, expiryFrom, readSubscriptions, subscribe, unsubscribe, wakePrompt, type CastRunner, type SubscriptionSource } from "./subscribe";

const NOW = Date.UTC(2026, 9, 26, 18, 0);

/** A conversation whose incoming messages are ids in `inbox`; the cursor is the highest id seen. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subs-"));
  const inbox: number[] = [];
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  let next = 40;
  const cast: CastRunner = (args, stdin) => {
    calls.push({ args, stdin });
    return args[1] === "add" ? { status: 0, stdout: `+ Trigger \x1b[36mtr-${next++}\x1b[0m every 5m: x\n`, stderr: "" } : { status: 0, stdout: "", stderr: "" };
  };
  const source: SubscriptionSource = {
    cli: "imsg",
    noun: "message",
    file: path.join(dir, "subscriptions.json"),
    resolve: async (target) => {
      if (target === "nobody") throw new Error("no conversation with nobody");
      return { key: `chat:${target}`, label: `Erica (${target})`, read: `imsg read ${target}`, cursor: Math.max(0, ...inbox) };
    },
    incoming: async (sub) => {
      const fresh = inbox.filter((id) => id > sub.cursor);
      return { count: fresh.length, cursor: Math.max(sub.cursor, ...fresh) };
    },
  };
  return { source, inbox, calls, cast };
}

describe("subscribe", () => {
  test("arms a trigger bound to the session whose precheck is the CLI's own check", async () => {
    const f = fixture();
    const { sub, existing } = await subscribe(f.source, "+14155550100", { session: "jx7abc", note: "enter the EIN", now: NOW, cast: f.cast });
    expect(existing).toBe(false);
    expect(sub.trigger).toBe("tr-40");
    const add = f.calls[0]!;
    expect(add.args).toContain("--for");
    expect(add.args[add.args.indexOf("--precheck") + 1]).toBe(`imsg subscription check ${sub.id}`);
    expect(add.stdin).toContain("imsg read +14155550100");
    expect(add.stdin).toContain("Carry on: enter the EIN");
    expect(add.stdin).toContain(`imsg unsubscribe ${sub.id}`);
    expect(readSubscriptions(f.source.file)).toHaveLength(1);
  });

  test("the same target from the same session keeps one trigger and takes the new note", async () => {
    const f = fixture();
    const first = await subscribe(f.source, "+14155550100", { session: "jx7abc", now: NOW, cast: f.cast });
    const again = await subscribe(f.source, "+14155550100", { session: "jx7abc", note: "file it", now: NOW + 1000, cast: f.cast });
    expect(again.existing).toBe(true);
    expect(again.sub.id).toBe(first.sub.id);
    expect(f.calls.map((c) => c.args[1])).toEqual(["add", "update"]);
    expect(readSubscriptions(f.source.file)[0]!.note).toBe("file it");
    // Another session waiting on the same person gets its own wake.
    const other = await subscribe(f.source, "+14155550100", { session: "jx7def", now: NOW, cast: f.cast });
    expect(other.existing).toBe(false);
  });

  test("an unknown target and a failed arm both say why and store nothing", async () => {
    const f = fixture();
    await expect(subscribe(f.source, "nobody", { now: NOW, cast: f.cast })).rejects.toThrow('Cannot subscribe to "nobody": no conversation with nobody');
    const broken: CastRunner = () => ({ status: 1, stdout: "", stderr: "Not logged in" });
    await expect(subscribe(f.source, "+1", { now: NOW, cast: broken })).rejects.toThrow("cast trigger add failed: Not logged in");
    expect(readSubscriptions(f.source.file)).toHaveLength(0);
  });
});

describe("check", () => {
  test("passes once per batch of new messages, then stays quiet", async () => {
    const f = fixture();
    f.inbox.push(10);
    const { sub } = await subscribe(f.source, "+1", { now: NOW, cast: f.cast });
    expect((await check(f.source, sub.id, { now: NOW })).code).toBe(1);
    f.inbox.push(11, 12);
    const woke = await check(f.source, sub.id, { now: NOW });
    expect(woke).toEqual({ code: 0, message: "2 new messages from Erica (+1)" });
    expect((await check(f.source, sub.id, { now: NOW })).code).toBe(1);
    const stored = readSubscriptions(f.source.file)[0]!;
    expect(stored.cursor).toBe(12);
    expect(stored.wakes).toBe(1);
  });

  test("an expired subscription cancels its trigger and removes itself", async () => {
    const f = fixture();
    const { sub } = await subscribe(f.source, "+1", { for: "1h", now: NOW, cast: f.cast });
    f.inbox.push(99);
    const result = await check(f.source, sub.id, { now: NOW + 2 * 3_600_000, cast: f.cast });
    expect(result.code).toBe(1);
    expect(f.calls.at(-1)!.args).toEqual(["trigger", "cancel", "tr-40"]);
    expect(readSubscriptions(f.source.file)).toHaveLength(0);
  });

  test("a once subscription wakes one time, then cancels its trigger at the next check", async () => {
    const f = fixture();
    const { sub } = await subscribe(f.source, "+1", { once: true, now: NOW, cast: f.cast });
    f.inbox.push(5);
    expect((await check(f.source, sub.id, { now: NOW, cast: f.cast })).code).toBe(0);
    f.inbox.push(6);
    const after = await check(f.source, sub.id, { now: NOW, cast: f.cast });
    expect(after.code).toBe(1);
    expect(f.calls.at(-1)!.args).toEqual(["trigger", "cancel", "tr-40"]);
    expect(readSubscriptions(f.source.file)).toHaveLength(0);
  });

  test("an unknown id is a skip", async () => {
    const f = fixture();
    expect((await check(f.source, "s-gone", { now: NOW })).code).toBe(1);
  });
});

test("unsubscribe by id or by target cancels the triggers", async () => {
  const f = fixture();
  const a = await subscribe(f.source, "+1", { now: NOW, cast: f.cast });
  await subscribe(f.source, "+2", { now: NOW, cast: f.cast });
  expect(unsubscribe(f.source, [a.sub.id, "+2"], { cast: f.cast }).map((s) => s.trigger)).toEqual(["tr-40", "tr-41"]);
  expect(readSubscriptions(f.source.file)).toHaveLength(0);
});

test("expiryFrom reads durations forward and dates as given", () => {
  expect(expiryFrom("7d", NOW)).toBe(NOW + 7 * 86_400_000);
  expect(expiryFrom("12h", NOW)).toBe(NOW + 12 * 3_600_000);
  expect(expiryFrom("2026-11-01T00:00:00Z", NOW)).toBe(Date.UTC(2026, 10, 1));
  expect(() => expiryFrom("soon", NOW)).toThrow("Cannot read");
});

test("a source's own wake prompt replaces the message wording", async () => {
  const f = fixture();
  const source = { ...f.source, wakePrompt: (sub: any, until: string) => `page matched ${sub.label}, until ${until}` };
  await subscribe(source, "+1", { now: NOW, cast: f.cast });
  expect(f.calls[0]!.stdin).toStartWith("page matched Erica (+1), until ");
});

test("without a note the wake prompt still says what to do", () => {
  const f = fixture();
  const text = wakePrompt(f.source, { id: "s-1", label: "Ada", read: "imsg read Ada", expires_at: NOW } as any);
  expect(text).toContain("Carry on with the work you were waiting on this reply for.");
});
