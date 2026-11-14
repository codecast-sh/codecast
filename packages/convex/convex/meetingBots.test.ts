// A meeting bot's life, end to end through the real webhook routes: a link is
// checked before a bot is paid for, Recall's signed status and transcript
// events turn the bot's meeting into a call owned by its sender, a teammate
// Recall matched by email reads it, a retried line is written once, an
// unsigned request is refused, and the end of the meeting ends the call.
import { afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { RECALL_REALTIME_PATH, RECALL_STATUS_PATH, recallSignature } from "./lib/recall";

setDefaultTimeout(60_000);

const api = anyApi as any;
const SECRET = "whsec_" + btoa("meeting-bots-test-key-0123456789");
const BOT = "bot_abc";

beforeAll(() => {
  process.env.RECALL_VERIFICATION_SECRET = SECRET;
});

const backends: any[] = [];
afterEach(async () => {
  backends.splice(0);
});

async function seed() {
  const t = convexTest(schema, allModules);
  backends.push(t);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const team = await ctx.db.insert("teams", { name: "T", created_at: now, invite_code: "x", features: { calls: true } } as any);
    const other = await ctx.db.insert("teams", { name: "O", created_at: now, invite_code: "y", features: { calls: true } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana", email: "ana@acme.test", active_team_id: team } as any);
    const ben = await ctx.db.insert("users", { name: "Ben", email: "ben@acme.test" } as any);
    const cat = await ctx.db.insert("users", { name: "Cat", email: "cat@other.test" } as any);
    for (const u of [ana, ben]) await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: now } as any);
    await ctx.db.insert("team_memberships", { user_id: cat, team_id: other, role: "member", joined_at: now } as any);
    return { team, ana, ben, cat };
  });
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  return { t, ...ids, as };
}

let msg = 0;
async function post(t: any, path: string, payload: unknown, opts: { sign?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const id = `msg_${++msg}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.sign !== false) {
    headers["webhook-id"] = id;
    headers["webhook-timestamp"] = ts;
    headers["webhook-signature"] = `v1,${await recallSignature(SECRET, id, ts, body)}`;
  }
  return await t.fetch(path, { method: "POST", headers, body });
}

const status = (meetId: string, event: string, sub_code: string | null = null) => ({
  event,
  data: { data: { code: event.slice(4), sub_code, updated_at: new Date().toISOString() }, bot: { id: BOT, metadata: { meet_id: meetId } } },
});

const line = (meetId: string, who: { id: number; name: string; email?: string }, words: Array<[string, number]>) => ({
  event: "transcript.data",
  data: {
    data: {
      words: words.map(([text, at]) => ({ text, start_timestamp: { relative: at }, end_timestamp: { relative: at + 0.3 } })),
      participant: { id: who.id, name: who.name, is_host: false, platform: "desktop", extra_data: null, email: who.email ?? null },
    },
    bot: { id: BOT, metadata: { meet_id: meetId } },
  },
});

async function sentBot(t: any, as: any, ana: string) {
  const row = await as(ana).mutation(api.meetingBots.send, { meeting_url: "https://meet.google.com/abc-defg-hij" });
  // Recall's create answered: the row knows its bot.
  await t.mutation((anyApi as any).meetingBots.recordCreate, { id: row._id, bot_id: BOT });
  return row;
}

describe("sending a bot", () => {
  test("a link no bot can join is refused before anything is paid for", async () => {
    const { as, ana } = await seed();
    await expect(as(String(ana)).mutation(api.meetingBots.send, { meeting_url: "https://example.com/x" })).rejects.toThrow(/Zoom/);
  });

  test("the same meeting asked for twice while its bot is going is one bot", async () => {
    const { as, ana } = await seed();
    const a = await as(String(ana)).mutation(api.meetingBots.send, { meeting_url: "meet.google.com/abc-defg-hij" });
    const b = await as(String(ana)).mutation(api.meetingBots.send, { meeting_url: "https://meet.google.com/abc-defg-hij" });
    expect(b.meet_id).toBe(a.meet_id);
    expect(a.status).toBe("requested");
    expect(a.platform_name).toBe("Google Meet");
    const mine = await as(String(ana)).query(api.meetingBots.listMine, {});
    expect(mine.length).toBe(1);
  });
});

describe("Recall events", () => {
  test("an unsigned or forged request is refused and changes nothing", async () => {
    const { t, as, ana } = await seed();
    const row = await sentBot(t, as, String(ana));
    const res = await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.in_call_recording"), { sign: false });
    expect(res.status).toBe(401);
    const after = await as(String(ana)).query(api.meetingBots.listMine, {});
    expect(after[0].status).toBe("joining");
    expect(after[0].transcript_id).toBeNull();
  });

  test("the meeting becomes the sender's call, lines land by speaker, and the end ends it", async () => {
    const { t, as, ana, ben, cat } = await seed();
    const row = await sentBot(t, as, String(ana));

    expect((await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.in_waiting_room"))).status).toBe(200);
    expect((await as(String(ana)).query(api.meetingBots.listMine, {}))[0].status).toBe("waiting_room");

    await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.in_call_recording"));
    const bot = (await as(String(ana)).query(api.meetingBots.listMine, {}))[0];
    expect(bot.status).toBe("recording");
    expect(bot.transcript_id).not.toBeNull();

    // A guest the meeting named, and a teammate Recall matched by email.
    await post(t, RECALL_REALTIME_PATH, line(row.meet_id, { id: 7, name: "Dana from Acme" }, [["Can", 3], ["we", 3.2], ["ship", 3.4], ["Friday?", 3.6]]));
    await post(t, RECALL_REALTIME_PATH, line(row.meet_id, { id: 8, name: "Ben P", email: "ben@acme.test" }, [["Yes", 5]]));
    // Recall retries a delivery it did not see answered: written once.
    await post(t, RECALL_REALTIME_PATH, line(row.meet_id, { id: 8, name: "Ben P", email: "ben@acme.test" }, [["Yes", 5]]));

    const call = await t.run(async (ctx: any) => {
      const tr = await ctx.db.get(bot.transcript_id);
      const segs = await ctx.db.query("transcript_segments").withIndex("by_transcript_seq", (q: any) => q.eq("transcript_id", tr._id)).collect();
      return { tr, segs };
    });
    expect(call.tr.room_key).toBe(`meet:${row.meet_id}`);
    expect(String(call.tr.started_by)).toBe(String(ana));
    expect(call.tr.status).toBe("live");
    expect(call.segs.map((s: any) => [s.speaker_name, s.text, s.t0])).toEqual([
      ["Dana from Acme", "Can we ship Friday?", 3000],
      ["Ben", "Yes", 5000],
    ]);
    expect(call.segs[0].speaker_id).toBe(`recall:${BOT}:7`);
    expect(call.segs[1].speaker_id).toBe(String(ben));

    // The sender and the matched teammate read it; someone on another team does not.
    expect(await as(String(ana)).query(api.transcripts.webGetCall, { transcript_id: bot.transcript_id })).not.toBeNull();
    expect(await as(String(ben)).query(api.transcripts.webGetCall, { transcript_id: bot.transcript_id })).not.toBeNull();
    expect(await as(String(cat)).query(api.transcripts.webGetCall, { transcript_id: bot.transcript_id })).toBeNull();

    await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.call_ended", "call_ended_by_host"));
    const ended = (await as(String(ana)).query(api.meetingBots.listMine, {}))[0];
    expect(ended.status).toBe("ended");
    expect(ended.status_words).toBe("The host ended the meeting.");
    const tr = await t.run(async (ctx: any) => await ctx.db.get(bot.transcript_id));
    expect(tr.status).toBe("ended");

    // bot.done after the end changes nothing.
    await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.done"));
    expect((await as(String(ana)).query(api.meetingBots.listMine, {}))[0].status).toBe("ended");
  });

  test("a line that arrives before the recording status still begins the call", async () => {
    const { t, as, ana } = await seed();
    const row = await sentBot(t, as, String(ana));
    await post(t, RECALL_REALTIME_PATH, line(row.meet_id, { id: 1, name: "Ana" }, [["Hello", 1]]));
    const bot = (await as(String(ana)).query(api.meetingBots.listMine, {}))[0];
    expect(bot.transcript_id).not.toBeNull();
  });

  test("removing the bot ends its call and no later event revives it", async () => {
    const { t, as, ana } = await seed();
    const row = await sentBot(t, as, String(ana));
    await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.in_call_recording"));
    const out = await as(String(ana)).mutation(api.meetingBots.cancel, { meet_id: row.meet_id });
    expect(out.status).toBe("cancelled");
    await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.in_call_recording"));
    const tr = await t.run(async (ctx: any) => await ctx.db.get(out.transcript_id));
    expect(tr.status).toBe("ended");
    expect((await as(String(ana)).query(api.meetingBots.listMine, {}))[0].status).toBe("cancelled");
  });

  test("a meeting key is no room: nobody can join, ring or knock into it", async () => {
    const { t, as, ana, ben } = await seed();
    const row = await sentBot(t, as, String(ana));
    await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.in_call_recording"));
    await expect(as(String(ben)).mutation(api.calls.joinRoom, { room_key: `meet:${row.meet_id}` })).rejects.toThrow();
    await expect(as(String(ana)).mutation(api.calls.joinRoom, { room_key: `meet:${row.meet_id}` })).rejects.toThrow();
  });
});

test("a send carries the web's client key back, and a second send to the open bot takes the newer key", async () => {
  const { as, ana } = await seed();
  const url = "https://meet.google.com/abc-defg-hij";
  const first = await as(ana).mutation(api.meetingBots.send, { meeting_url: url, client_key: "k1" });
  expect(first.client_key).toBe("k1");
  const again = await as(ana).mutation(api.meetingBots.send, { meeting_url: url, client_key: "k2" });
  expect(again.meet_id).toBe(first.meet_id);
  expect(again.client_key).toBe("k2");
  const mine = await as(ana).query(api.meetingBots.listMine, {});
  expect(mine.map((b: any) => b.client_key)).toEqual(["k2"]);
});

const chat = (meetId: string, who: { id: number; name: string; email?: string }, text: string, to = "everyone") => ({
  event: "participant_events.chat_message",
  data: {
    data: {
      participant: { id: who.id, name: who.name, is_host: false, platform: "desktop", extra_data: null, email: who.email ?? null },
      timestamp: { absolute: new Date().toISOString(), relative: 10 },
      data: { text, to },
    },
    bot: { id: BOT, metadata: { meet_id: meetId } },
  },
});

describe("the meeting's chat", () => {
  test("a line in the meeting's chat joins the call's chat under the meeting's name; the bot's echo and DMs to it do not", async () => {
    const { t, as, ana, ben } = await seed();
    const row = await sentBot(t, as, String(ana));
    await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.in_call_recording"));
    await post(t, RECALL_REALTIME_PATH, chat(row.meet_id, { id: 7, name: "Dana from Acme" }, "Can you send the deck?"));
    await post(t, RECALL_REALTIME_PATH, chat(row.meet_id, { id: 8, name: "Ben P", email: "ben@acme.test" }, "On it"));
    await post(t, RECALL_REALTIME_PATH, chat(row.meet_id, { id: 1, name: "Codecast Notetaker" }, "an echo of our own"));
    await post(t, RECALL_REALTIME_PATH, chat(row.meet_id, { id: 7, name: "Dana from Acme" }, "just to the bot", "1"));

    const bot = (await as(String(ana)).query(api.meetingBots.listMine, {}))[0];
    const call = await t.run(async (ctx: any) => await ctx.db.get(bot.transcript_id));
    const rows = await as(String(ana)).query(api.callChat.list, { room_key: call.room_key, transcript_id: call._id });
    expect(rows.map((r: any) => [r.user_name, r.text, r.mine])).toEqual([
      ["Dana from Acme", "Can you send the deck?", false],
      ["Ben", "On it", false],
    ]);
    // A teammate the bot heard reads the chat; nobody else can list a meeting's chat.
    await post(t, RECALL_REALTIME_PATH, line(row.meet_id, { id: 8, name: "Ben P", email: "ben@acme.test" }, [["Sure", 4]]));
    expect((await as(String(ben)).query(api.callChat.list, { room_key: call.room_key, transcript_id: call._id }))?.length).toBe(2);
    expect(await as(String(ben)).query(api.callChat.list, { room_key: call.room_key })).toBeNull();
  });

  test("an agent's reply goes into the meeting's chat as plain text within the platform's limit", async () => {
    const { t, as, ana } = await seed();
    const row = await sentBot(t, as, String(ana));
    await post(t, RECALL_STATUS_PATH, status(row.meet_id, "bot.in_call_recording"));
    const bot = (await as(String(ana)).query(api.meetingBots.listMine, {}))[0];
    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    process.env.RECALL_API_KEY = "test-key";
    globalThis.fetch = (async (url: string, init: any) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as any;
    try {
      await t.action((anyApi as any).meetingBots.sayInMeeting, {
        transcript_id: bot.transcript_id,
        texts: ["Here is **the deck**: [link](https://x.test/deck)", "x ".repeat(400)],
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.RECALL_API_KEY;
    }
    expect(sent.map((s) => s.url)).toEqual([
      `https://us-west-2.recall.ai/api/v1/bot/${BOT}/send_chat_message/`,
      `https://us-west-2.recall.ai/api/v1/bot/${BOT}/send_chat_message/`,
    ]);
    expect(sent[0].body).toEqual({ to: "everyone", message: "Here is the deck: link (https://x.test/deck)" });
    // Google Meet takes 500 characters a message.
    expect(sent[1].body.message.length).toBeLessThanOrEqual(500);
    expect(sent[1].body.message.endsWith("…")).toBe(true);
  });
});

describe("the meeting's video", () => {
  const SIZE = 9 * 1024 * 1024; // two 8 MB parts
  function fakeServices(opts: { processing?: boolean } = {}) {
    const calls: string[] = [];
    const parts: number[] = [];
    const source = new Uint8Array(SIZE);
    const fetchFn = async (input: any, init: any = {}) => {
      const url = String(input);
      const method = (init.method ?? "GET").toUpperCase();
      if (url.startsWith("https://us-west-2.recall.ai/api/v1/bot/")) {
        calls.push("recall:get");
        return new Response(JSON.stringify({
          recordings: [{
            id: "rec_1",
            started_at: "2026-11-14T11:37:38Z",
            completed_at: "2026-11-14T11:47:38Z",
            media_shortcuts: { video_mixed: opts.processing
              ? { status: { code: "processing" }, data: { download_url: null } }
              : { status: { code: "done" }, data: { download_url: "https://media.recall.test/v.mp4" } } },
          }],
        }), { status: 200 });
      }
      if (url.startsWith("https://media.recall.test/")) {
        const [a, b] = String(init.headers?.Range ?? "").replace("bytes=", "").split("-").map(Number);
        return new Response(source.slice(a, b + 1), { status: 206, headers: { "content-range": `bytes ${a}-${b}/${SIZE}` } });
      }
      if (url.startsWith("https://r2.test/")) {
        const q = new URL(url).searchParams;
        if (method === "POST" && q.has("uploads")) { calls.push("r2:create"); return new Response("<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>"); }
        if (method === "PUT") { parts.push((init.body as ArrayBuffer).byteLength); return new Response("", { headers: { etag: `"e${q.get("partNumber")}"` } }); }
        if (method === "POST") { calls.push("r2:complete"); return new Response("<CompleteMultipartUploadResult/>"); }
      }
      return new Response("unexpected", { status: 500 });
    };
    return { calls, parts, fetchFn };
  }

  async function withServices<T>(fetchFn: any, run: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    const env = { RECALL_API_KEY: "k", R2_ENDPOINT: "https://r2.test", CALL_REC_R2_BUCKET: "recs", CALL_REC_R2_ACCESS_KEY_ID: "a", CALL_REC_R2_SECRET_ACCESS_KEY: "s" };
    Object.assign(process.env, env);
    globalThis.fetch = fetchFn;
    try { return await run(); } finally {
      globalThis.fetch = real;
      for (const k of Object.keys(env)) delete (process.env as any)[k];
    }
  }

  /** The bot finishes with fake services in place; the copy that bot.done
   *  schedules runs on its own, and this waits for it to settle. */
  async function doneBot(fetchFn: any) {
    const s = await seed();
    return await withServices(fetchFn, async () => {
      const row = await sentBot(s.t, s.as, String(s.ana));
      await post(s.t, RECALL_STATUS_PATH, status(row.meet_id, "bot.in_call_recording"));
      await post(s.t, RECALL_STATUS_PATH, status(row.meet_id, "bot.call_ended"));
      await post(s.t, RECALL_STATUS_PATH, status(row.meet_id, "bot.done"));
      const read = () => s.t.run(async (ctx: any) => await ctx.db.query("meeting_bots").first());
      for (let i = 0; i < 100; i++) {
        const b = await read();
        if (b.video_status !== "saving" || (b.video_attempts ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await s.t.finishInProgressScheduledFunctions();
      return { ...s, botRow: await read() };
    });
  }

  test("once the bot is done its video is copied part by part and filed as the call's video", async () => {
    const svc = fakeServices();
    const { t, botRow } = await doneBot(svc.fetchFn);
    expect(svc.parts).toEqual([8 * 1024 * 1024, 1024 * 1024]);
    expect(svc.calls).toEqual(["recall:get", "r2:create", "r2:complete"]);
    const out = await t.run(async (ctx: any) => ({
      call: await ctx.db.get(botRow.transcript_id),
      recs: await ctx.db.query("call_recordings").collect(),
    }));
    expect(botRow.video_status).toBe("saved");
    expect(out.call.video_runs).toBe(1);
    expect(out.recs).toHaveLength(1);
    expect(out.recs[0]).toMatchObject({ kind: "composite", status: "ready", size_bytes: SIZE, duration_ms: 600_000 });
    expect(out.recs[0].r2_key).toBe(`calls/${botRow.transcript_id}/${Date.parse("2026-11-14T11:37:38Z")}-composite.mp4`);
  });

  test("a video Recall is still processing is looked at again, not given up on", async () => {
    const svc = fakeServices({ processing: true });
    const { botRow } = await doneBot(svc.fetchFn);
    expect(botRow.video_status).toBe("saving");
    expect(botRow.video_attempts).toBe(1);
    expect(svc.parts).toEqual([]);
  });
});
