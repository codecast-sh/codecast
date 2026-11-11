import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { watchBrowser, getBrowser, cliPushBrowserFrame, sendBrowserInput } from "./browserStream";

// The browser watch relay's lease protocol, end to end through the four
// functions: a viewer's lease queues one command, the daemon's pushes fill the
// row and learn the lease from the reply, input rides back exactly once, a
// stream's ending reaches the viewer and is cleared by the next request, and
// none of it opens for someone else's machine.
const ME = "u".repeat(31) + "m";
const STRANGER = "u".repeat(31) + "s";

function fixtures() {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me" },
      { _id: STRANGER, name: "Stranger" },
    ],
    devices: [{ _id: "d1", user_id: ME, device_id: "mini", label: "macOS - Mac-mini", platform: "darwin", last_seen: 0 }],
    browser_frames: [],
    daemon_commands: [],
  });
}

const as = (db: any, userId: string): any => ({
  db,
  auth: { getUserIdentity: async () => ({ subject: `${userId}|sess`, tokenIdentifier: "x" }) },
});
const run = (fn: any, ctx: any, args: any) => ((fn as any)._handler ?? (fn as any).handler)(ctx, args);
const commands = (db: any) => db._tables.daemon_commands.filter((c: any) => c.command === "stream_browser");
const KEY = "0f6c1d2e-aaaa-bbbb-cccc-123456789abc";
const view = { device_id: "mini", key: KEY };

describe("browser watch relay", () => {
  test("a lease queues one stream command; renewals while it streams queue none", async () => {
    const db = fixtures();
    const res = await run(watchBrowser, as(db, ME), { ...view, session_uuid: KEY, tmux_session: "cc-abc" });
    expect(res).toEqual({ ok: true, dispatched: true });
    expect(commands(db)).toHaveLength(1);
    expect(JSON.parse(commands(db)[0].args)).toEqual({ key: KEY, session_uuid: KEY, tmux_session: "cc-abc" });
    expect(commands(db)[0].target_device_id).toBe("mini");

    // The daemon answers; a renewal now only extends the lease.
    await run(cliPushBrowserFrame, as(db, ME), { api_token: "t", ...view, tab: { id: "T1", title: "Login", url: "https://x.test" }, control: true });
    await run(watchBrowser, as(db, ME), view);
    expect(commands(db)).toHaveLength(1);
  });

  test("pushes fill the row the viewer reads; the reply carries the lease", async () => {
    const db = fixtures();
    await run(watchBrowser, as(db, ME), view);
    const answer = await run(cliPushBrowserFrame, as(db, ME), {
      api_token: "t",
      ...view,
      frame: "AAAA",
      frame_w: 800,
      frame_h: 600,
      tab: { id: "T1", title: "Login", url: "https://x.test" },
      control: true,
      actions: JSON.stringify([{ type: "action", kind: "move", x: 0.5, y: 0.5, at: 1 }]),
    });
    expect(answer.stop).toBe(false);
    const row = await run(getBrowser, as(db, ME), view);
    expect(row).toMatchObject({ frame: "AAAA", frame_w: 800, frame_h: 600, seq: 1, control: true, end: null });
    expect(row.tab).toEqual({ id: "T1", title: "Login", url: "https://x.test" });
    expect(row.actions).toHaveLength(1);

    // A heartbeat leaves the picture alone.
    await run(cliPushBrowserFrame, as(db, ME), { api_token: "t", ...view });
    expect((await run(getBrowser, as(db, ME), view)).seq).toBe(1);
  });

  test("a lapsed lease tells the daemon to stop", async () => {
    const db = fixtures();
    await run(watchBrowser, as(db, ME), view);
    db._tables.browser_frames[0].watch_until = Date.now() - 1;
    const answer = await run(cliPushBrowserFrame, as(db, ME), { api_token: "t", ...view });
    expect(answer.stop).toBe(true);
  });

  test("input is refused with no streamer, then delivered exactly once", async () => {
    const db = fixtures();
    await run(watchBrowser, as(db, ME), view);
    const click = { kind: "mouse", type: "mousePressed", nx: 0.1, ny: 0.2, button: "left", clickCount: 1 };
    expect(await run(sendBrowserInput, as(db, ME), { ...view, events: [click] })).toEqual({ ok: false, reason: "no-streamer" });

    await run(cliPushBrowserFrame, as(db, ME), { api_token: "t", ...view });
    expect(await run(sendBrowserInput, as(db, ME), { ...view, events: [click] })).toEqual({ ok: true });
    const first = await run(cliPushBrowserFrame, as(db, ME), { api_token: "t", ...view });
    expect(first.input).toEqual([click]);
    expect(first.fast).toBe(true);
    const second = await run(cliPushBrowserFrame, as(db, ME), { api_token: "t", ...view });
    expect(second.input).toBeUndefined();
  });

  test("an ending reaches the viewer, and the next request starts clean at once", async () => {
    const db = fixtures();
    await run(watchBrowser, as(db, ME), view);
    await run(cliPushBrowserFrame, as(db, ME), { api_token: "t", ...view, frame: "AAAA", tab: { id: "T1", title: "a", url: "b" } });
    await run(cliPushBrowserFrame, as(db, ME), { api_token: "t", ...view, end: JSON.stringify({ kind: "exit", code: "timeout" }) });
    expect((await run(getBrowser, as(db, ME), view)).end).toEqual({ kind: "exit", code: "timeout" });

    // Resume: a new command goes out without waiting out the stale window,
    // and the previous stream's ending, picture and tab are gone.
    const res = await run(watchBrowser, as(db, ME), view);
    expect(res.dispatched).toBe(true);
    expect(commands(db)).toHaveLength(2);
    const row = await run(getBrowser, as(db, ME), view);
    expect(row).toMatchObject({ end: null, frame: null, tab: null });
  });

  test("someone else's machine opens nothing", async () => {
    const db = fixtures();
    expect(await run(watchBrowser, as(db, STRANGER), view)).toEqual({ ok: false, reason: "unknown-device" });
    expect(commands(db)).toHaveLength(0);
    await run(watchBrowser, as(db, ME), view);
    expect(await run(getBrowser, as(db, STRANGER), view)).toBeNull();
    expect((await run(sendBrowserInput, as(db, STRANGER), { ...view, events: [{ kind: "insertText", text: "x" }] })).ok).toBe(false);
  });

  test("a key with tmux format characters is refused", async () => {
    const db = fixtures();
    await expect(run(watchBrowser, as(db, ME), { device_id: "mini", key: "cc-#{pane}" })).rejects.toThrow();
  });
});
