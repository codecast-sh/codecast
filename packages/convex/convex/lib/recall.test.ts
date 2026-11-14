import { describe, expect, test } from "bun:test";
import {
  lineFromTranscriptData,
  parseMeetingUrl,
  recallBotBody,
  recallSignature,
  statusFromRecallEvent,
  verifyRecallRequest,
} from "./recall";

// A workspace secret shaped like Recall's: "whsec_" + base64 key bytes.
const SECRET = "whsec_" + btoa("test-key-0123456789abcdef-0123456789");

async function signed(body: string, opts: { id?: string; ts?: number; secret?: string; prefix?: "webhook" | "svix" } = {}) {
  const id = opts.id ?? "msg_1";
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = await recallSignature(opts.secret ?? SECRET, id, ts, body);
  const p = opts.prefix ?? "webhook";
  return new Headers({ [`${p}-id`]: id, [`${p}-timestamp`]: ts, [`${p}-signature`]: `v1,${sig}` });
}

describe("parseMeetingUrl", () => {
  test("names each platform a bot can join", () => {
    const cases: Array<[string, string]> = [
      ["https://us02web.zoom.us/j/8123456789?pwd=abc", "zoom"],
      ["meet.google.com/abc-defg-hij", "google_meet"],
      ["https://teams.microsoft.com/l/meetup-join/19%3ameeting_x", "microsoft_teams"],
      ["https://teams.live.com/meet/9381234", "microsoft_teams"],
      ["https://acme.webex.com/meet/ann", "webex"],
      ["https://meet.goto.com/123456789", "goto_meeting"],
    ];
    for (const [url, platform] of cases) {
      const r = parseMeetingUrl(url);
      expect(r.ok && r.platform).toBe(platform as any);
    }
  });

  test("refuses what no bot can join, saying which platforms work", () => {
    const r = parseMeetingUrl("https://example.com/call/1");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("Zoom");
    expect(parseMeetingUrl("https://meet.google.com/").ok).toBe(false);
    expect(parseMeetingUrl("not a url at all").ok).toBe(false);
    expect(parseMeetingUrl("javascript:alert(1)").ok).toBe(false);
  });

  test("a zoom-looking host that is not zoom is refused", () => {
    expect(parseMeetingUrl("https://zoom.us.evil.com/j/1").ok).toBe(false);
  });
});

describe("verifyRecallRequest", () => {
  const body = JSON.stringify({ event: "bot.done" });

  test("accepts Recall's signature under either header set", async () => {
    expect(await verifyRecallRequest({ secret: SECRET, headers: await signed(body), body })).toEqual({ ok: true, id: "msg_1" });
    expect((await verifyRecallRequest({ secret: SECRET, headers: await signed(body, { prefix: "svix" }), body })).ok).toBe(true);
  });

  test("refuses a changed body, another secret, no signature and no secret", async () => {
    const headers = await signed(body);
    expect(await verifyRecallRequest({ secret: SECRET, headers, body: body + " " })).toEqual({ ok: false, reason: "bad signature" });
    const other = "whsec_" + btoa("another-key-entirely-0123456789");
    expect((await verifyRecallRequest({ secret: SECRET, headers: await signed(body, { secret: other }), body })).ok).toBe(false);
    expect(await verifyRecallRequest({ secret: SECRET, headers: new Headers(), body })).toEqual({ ok: false, reason: "unsigned request" });
    expect((await verifyRecallRequest({ secret: undefined, headers, body })).ok).toBe(false);
  });

  test("refuses a signature replayed outside the window", async () => {
    const old = Math.floor(Date.now() / 1000) - 10 * 60;
    expect(await verifyRecallRequest({ secret: SECRET, headers: await signed(body, { ts: old }), body })).toEqual({
      ok: false,
      reason: "stale signature",
    });
  });

  test("any one of several space-separated signatures may match", async () => {
    const h = await signed(body);
    h.set("webhook-signature", `v1,AAAA ${h.get("webhook-signature")}`);
    expect((await verifyRecallRequest({ secret: SECRET, headers: h, body })).ok).toBe(true);
  });
});

describe("Recall events", () => {
  test("statuses map to the bot's life, and unknown events change nothing", () => {
    expect(statusFromRecallEvent("bot.in_waiting_room")).toBe("waiting_room");
    expect(statusFromRecallEvent("bot.in_call_recording")).toBe("recording");
    expect(statusFromRecallEvent("bot.call_ended")).toBe("ended");
    expect(statusFromRecallEvent("bot.fatal")).toBe("failed");
    expect(statusFromRecallEvent("bot.breakout_room_entered")).toBeNull();
  });

  test("a transcript event reads as one timed line", () => {
    const line = lineFromTranscriptData(
      {
        words: [
          { text: "Ship", start_timestamp: { relative: 12.5 }, end_timestamp: { relative: 12.8 } },
          { text: "it", start_timestamp: { relative: 12.9 }, end_timestamp: { relative: 13.0 } },
          { text: ".", start_timestamp: { relative: 13.0 }, end_timestamp: null },
        ],
      },
      0,
    );
    expect(line).toEqual({ text: "Ship it.", t0: 12500, t1: 13000 });
    expect(lineFromTranscriptData({ words: [{ text: "  " }] }, 0)).toBeNull();
  });

  test("the bot is asked for fast lines on our real-time endpoint, tagged with our id", () => {
    const body: any = recallBotBody({ meetId: "m-123456789", meetingUrl: "https://meet.google.com/abc-defg-hij", siteUrl: "https://x.convex.site/" });
    expect(body.metadata).toEqual({ meet_id: "m-123456789" });
    expect(body.recording_config.transcript.provider.recallai_streaming.mode).toBe("prioritize_low_latency");
    expect(body.recording_config.realtime_endpoints[0].url).toBe("https://x.convex.site/api/webhooks/recall/realtime");
    expect(body.join_at).toBeUndefined();
  });
});

describe("meetingChatText", () => {
  test("no chat where the platform gives bots none", async () => {
    const { meetingChatText } = await import("./recall");
    expect(meetingChatText("hi", "webex")).toBeNull();
    expect(meetingChatText("hi", "goto_meeting")).toBeNull();
    expect(meetingChatText("```ts\nconst a = 1\n```\n## Plan\n`x` done", "zoom")).toBe("const a = 1\n\nPlan\nx done");
    expect(meetingChatText("   ", "zoom")).toBeNull();
  });
});

describe("meetingOfEvent", () => {
  const base = { id: "e1", summary: "Standup", start: { dateTime: "2026-11-15T17:00:00Z" }, end: { dateTime: "2026-11-15T17:30:00Z" } };
  test("finds the link wherever the invite put it", async () => {
    const { meetingOfEvent } = await import("./recall");
    expect(meetingOfEvent({ ...base, hangoutLink: "https://meet.google.com/abc-defg-hij" })?.platform).toBe("google_meet");
    expect(meetingOfEvent({ ...base, conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1" }, { entryPointType: "video", uri: "https://us02web.zoom.us/j/81234" }] } })?.platform).toBe("zoom");
    expect(meetingOfEvent({ ...base, description: '<a href="https://teams.microsoft.com/l/meetup-join/19%3a">Join</a>' })?.platform).toBe("microsoft_teams");
    expect(meetingOfEvent({ ...base, hangoutLink: "https://meet.google.com/abc-defg-hij" })).toMatchObject({ starts_at: Date.parse("2026-11-15T17:00:00Z"), title: "Standup" });
  });
  test("no bot for all-day, cancelled, declined or linkless events", async () => {
    const { meetingOfEvent } = await import("./recall");
    const link = { hangoutLink: "https://meet.google.com/abc-defg-hij" };
    expect(meetingOfEvent({ ...base, ...link, start: { date: "2026-11-15" }, end: { date: "2026-11-16" } })).toBeNull();
    expect(meetingOfEvent({ ...base, ...link, status: "cancelled" })).toBeNull();
    expect(meetingOfEvent({ ...base, ...link, attendees: [{ self: true, responseStatus: "declined" }] })).toBeNull();
    expect(meetingOfEvent({ ...base, location: "Room 4" })).toBeNull();
  });
});
