import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { cliPushClipboard, cliPushFrame, getPane, getPaneClipboard, pruneStaleFrames, watchPane } from "./terminalStream";
import { PANE_CLIPBOARD_TTL_MS, PANE_MAX_CLIPBOARD_CHARS } from "@codecast/shared/contracts";

// The clipboard bridge's relay half: a daemon offers the text of a new tmux
// buffer, the viewer reads it beside the frame. Only a pane someone is
// watching takes an offer, and only the pane's own account can make one.
const ME = "u".repeat(31) + "m";
const OTHER = "u".repeat(31) + "o";

function fixtures() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me" }, { _id: OTHER, name: "Other" }],
    devices: [{ _id: "d1", user_id: ME, device_id: "mydev", label: "macOS - MacBook", platform: "darwin", last_seen: 0 }],
    terminal_frames: [],
    terminal_clipboards: [],
    daemon_commands: [],
  });
}

const as = (db: any, userId: string): any => ({
  db,
  auth: { getUserIdentity: async () => ({ subject: `${userId}|sess`, tokenIdentifier: "x" }) },
});
const run = (fn: any, ctx: any, args: any) => ((fn as any)._handler ?? (fn as any).handler)(ctx, args);
const pane = { device_id: "mydev", target: "cc-abc123" };
const clipRow = (db: any) => db._tables.terminal_clipboards[0];

describe("clipboard offers", () => {
  test("an offer on a watched pane reaches the viewer with its stamp", async () => {
    const db = fixtures();
    expect((await run(watchPane, as(db, ME), pane)).ok).toBe(true);
    expect(await run(getPaneClipboard, as(db, ME), pane)).toBeNull();
    expect(await run(cliPushClipboard, as(db, ME), { ...pane, api_token: "", text: "copied line" })).toEqual({ ok: true });
    const after = await run(getPaneClipboard, as(db, ME), pane);
    expect(after.clipboard).toBe("copied line");
    expect(typeof after.clipboard_at).toBe("number");
  });

  test("nobody watching, no offer", async () => {
    const db = fixtures();
    expect(await run(cliPushClipboard, as(db, ME), { ...pane, api_token: "", text: "x" })).toEqual({ ok: false });
  });

  test("a lapsed lease takes no offer", async () => {
    const db = fixtures();
    await run(watchPane, as(db, ME), pane);
    const row = (db as any)._tables.terminal_frames?.[0] ?? (db as any)._inserted.find((i: any) => i.table === "terminal_frames").doc;
    row.watch_until = Date.now() - 1;
    expect(await run(cliPushClipboard, as(db, ME), { ...pane, api_token: "", text: "x" })).toEqual({ ok: false });
  });

  test("another account cannot write into my pane's row", async () => {
    const db = fixtures();
    await run(watchPane, as(db, ME), pane);
    expect(await run(cliPushClipboard, as(db, OTHER), { ...pane, api_token: "", text: "spoof" })).toEqual({ ok: false });
    expect(await run(getPaneClipboard, as(db, ME), pane)).toBeNull();
  });

  test("long text is capped", async () => {
    const db = fixtures();
    await run(watchPane, as(db, ME), pane);
    await run(cliPushClipboard, as(db, ME), { ...pane, api_token: "", text: "a".repeat(PANE_MAX_CLIPBOARD_CHARS + 10) });
    expect((await run(getPaneClipboard, as(db, ME), pane)).clipboard.length).toBe(PANE_MAX_CLIPBOARD_CHARS);
  });

  test("a frame push leaves the offer alone; the prune removes it past the TTL", async () => {
    const db = fixtures();
    await run(watchPane, as(db, ME), pane);
    await run(cliPushClipboard, as(db, ME), { ...pane, api_token: "", text: "copied" });
    await run(cliPushFrame, as(db, ME), { ...pane, api_token: "", frame: "screen" });
    expect((await run(getPaneClipboard, as(db, ME), pane)).clipboard).toBe("copied");
    clipRow(db).at = Date.now() - PANE_CLIPBOARD_TTL_MS - 1;
    await run(pruneStaleFrames, as(db, ME), {});
    expect((db as any)._tables.terminal_clipboards).toHaveLength(0);
  });

  test("a new lease after a lapsed one starts without the old offer", async () => {
    const db = fixtures();
    await run(watchPane, as(db, ME), pane);
    await run(cliPushClipboard, as(db, ME), { ...pane, api_token: "", text: "yesterday" });
    const row = (db as any)._tables.terminal_frames?.[0] ?? (db as any)._inserted.find((i: any) => i.table === "terminal_frames").doc;
    row.watch_until = Date.now() - 1;
    await run(watchPane, as(db, ME), pane);
    expect(await run(getPaneClipboard, as(db, ME), pane)).toBeNull();
  });

  test("a stranger reads no offer", async () => {
    const db = fixtures();
    await run(watchPane, as(db, ME), pane);
    await run(cliPushClipboard, as(db, ME), { ...pane, api_token: "", text: "mine" });
    expect(await run(getPaneClipboard, as(db, OTHER), pane)).toBeNull();
  });

  test("an offer past its TTL is not read back, even with no push since", async () => {
    const db = fixtures();
    await run(watchPane, as(db, ME), pane);
    await run(cliPushClipboard, as(db, ME), { ...pane, api_token: "", text: "old" });
    clipRow(db).at = Date.now() - PANE_CLIPBOARD_TTL_MS - 1;
    expect(await run(getPaneClipboard, as(db, ME), pane)).toBeNull();
  });

  test("a new lease does not hand the last stream's error to a new viewer", async () => {
    const db = fixtures();
    await run(watchPane, as(db, ME), pane);
    await run(cliPushFrame, as(db, ME), { ...pane, api_token: "", error: "pane is gone" });
    expect((await run(getPane, as(db, ME), pane)).error).toBe("pane is gone");
    const row = (db as any)._tables.terminal_frames?.[0] ?? (db as any)._inserted.find((i: any) => i.table === "terminal_frames").doc;
    row.watch_until = Date.now() - 1;
    await run(watchPane, as(db, ME), pane);
    expect((await run(getPane, as(db, ME), pane)).error).toBeNull();
  });
});
