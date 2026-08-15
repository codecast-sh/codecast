import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  CALL_INVITE_TTL_MS,
  CALL_MEMBER_STALE_MS,
  signLivekitJwt,
} from "./calls";

function b64urlToJson(part: string): any {
  const pad = part.length % 4 === 0 ? "" : "=".repeat(4 - (part.length % 4));
  return JSON.parse(
    Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString(
      "utf8",
    ),
  );
}

describe("signLivekitJwt", () => {
  test("produces a verifiable HS256 token with the LiveKit video grant", async () => {
    const token = await signLivekitJwt({
      apiKey: "APIkey123",
      apiSecret: "secret456",
      identity: "user-1",
      name: "Ashot",
      room: "dm:a:b",
      metadata: JSON.stringify({ image: "https://x/y.png" }),
      ttlSeconds: 3600,
      nowSeconds: 1_800_000_000,
    });
    const [h, p, s] = token.split(".");
    expect(b64urlToJson(h)).toEqual({ alg: "HS256", typ: "JWT" });
    const payload = b64urlToJson(p);
    expect(payload.iss).toBe("APIkey123");
    expect(payload.sub).toBe("user-1");
    expect(payload.name).toBe("Ashot");
    expect(payload.nbf).toBe(1_800_000_000 - 10);
    expect(payload.exp).toBe(1_800_000_000 + 3600);
    expect(payload.video).toEqual({
      room: "dm:a:b",
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    // Independent signature check with node crypto — the token must verify
    // against the same secret LiveKit would use.
    const expected = createHmac("sha256", "secret456")
      .update(`${h}.${p}`)
      .digest("base64url");
    expect(s).toBe(expected);
  });

  test("token is scoped to exactly one room", async () => {
    const token = await signLivekitJwt({
      apiKey: "k",
      apiSecret: "s",
      identity: "u",
      name: "n",
      room: "channel:ch1",
      nowSeconds: 1_800_000_000,
    });
    const payload = b64urlToJson(token.split(".")[1]);
    expect(payload.video.room).toBe("channel:ch1");
    expect(payload.video.roomAdmin).toBeUndefined();
    expect(payload.video.roomCreate).toBeUndefined();
  });
});

describe("lease constants", () => {
  test("stale window comfortably exceeds the heartbeat", () => {
    // Three missed 15s heartbeats before a member reads as gone — same
    // two-missed-beats-plus-slack philosophy as PRESENCE_FRESH_MS.
    expect(CALL_MEMBER_STALE_MS).toBe(45_000);
    expect(CALL_INVITE_TTL_MS).toBe(45_000);
  });
});
