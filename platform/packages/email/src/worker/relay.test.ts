// The Worker handler is a reference file, but the port is verified here with
// a fake binding; no Cloudflare runtime is involved.

import { describe, expect, test } from "bun:test";
import { createEmailRelayHandler, type EmailRelayEnv } from "./relay";

const FROM = { email: "hello@sapling.day", name: "Sapling" };

function makeEnv(sendResult?: () => Promise<{ messageId?: string }>): {
  env: EmailRelayEnv;
  sent: unknown[];
} {
  const sent: unknown[] = [];
  return {
    sent,
    env: {
      EMAIL_SECRET: "s3cret",
      EMAIL: {
        send: async (msg) => {
          sent.push(msg);
          return sendResult ? sendResult() : { messageId: "m1" };
        },
      },
    },
  };
}

function post(body: unknown, auth = "Bearer s3cret"): Request {
  return new Request("https://sapling.day/api/email", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const handler = createEmailRelayHandler({ from: FROM });

describe("email relay handler", () => {
  test("rejects non POST", async () => {
    const { env } = makeEnv();
    const res = await handler(new Request("https://x/api/email"), env);
    expect(res.status).toBe(405);
  });

  test("rejects a missing or wrong bearer, and a missing secret", async () => {
    const { env } = makeEnv();
    expect((await handler(post({}, "Bearer wrong"), env)).status).toBe(401);
    expect((await handler(post({}, ""), env)).status).toBe(401);
    const noSecret: EmailRelayEnv = { ...env, EMAIL_SECRET: undefined };
    expect((await handler(post({}), noSecret)).status).toBe(401);
  });

  test("rejects bad JSON and missing fields", async () => {
    const { env } = makeEnv();
    expect((await handler(post("{nope"), env)).status).toBe(400);
    expect((await handler(post({ to: "a@b.co" }), env)).status).toBe(400);
  });

  test("sends through the binding and reports the message id", async () => {
    const { env, sent } = makeEnv();
    const res = await handler(
      post({ to: "a@b.co", subject: "s", text: "t", html: "<p>h</p>" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: "m1" });
    expect(sent[0]).toEqual({
      to: "a@b.co",
      from: FROM,
      subject: "s",
      text: "t",
      html: "<p>h</p>",
    });
  });

  test("empty html becomes undefined", async () => {
    const { env, sent } = makeEnv();
    await handler(post({ to: "a@b.co", subject: "s", text: "t", html: "" }), env);
    expect((sent[0] as { html?: string }).html).toBeUndefined();
  });

  test("binding failure returns 502 with the error", async () => {
    const { env } = makeEnv(() => Promise.reject(new Error("smtp down")));
    const res = await handler(post({ to: "a@b.co", subject: "s", text: "t" }), env);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "smtp down" });
  });
});
