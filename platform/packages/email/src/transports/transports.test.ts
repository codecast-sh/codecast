import { describe, expect, spyOn, test } from "bun:test";
import { createRelayTransport } from "./relay";
import { createResendTransport, resendTransportForBrand } from "./resend";
import { transportFromEnv } from "./index";
import type { FetchLike } from "./types";

const MESSAGE = {
  to: "dev@example.com",
  subject: "Hello",
  html: "<p>hi</p>",
  text: "hi",
};

function fakeFetch(status: number, body = "{}") {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const impl: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return new Response(body, { status });
  };
  return { impl, calls };
}

describe("resend transport", () => {
  test("posts the message with auth, tag, and headers", async () => {
    const { impl, calls } = fakeFetch(200);
    const t = createResendTransport({
      apiKey: "re_key",
      from: "Codecast <support@codecast.sh>",
      replyTo: "support@codecast.sh",
      fetch: impl,
    });
    await t.send(MESSAGE, { tag: "digest", headers: { "List-Unsubscribe": "<https://u>" } });

    expect(calls.length).toBe(1);
    expect(calls[0].input).toBe("https://api.resend.com/emails");
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      from: "Codecast <support@codecast.sh>",
      to: ["dev@example.com"],
      reply_to: "support@codecast.sh",
      subject: "Hello",
      html: "<p>hi</p>",
      text: "hi",
      tags: [{ name: "template", value: "digest" }],
      headers: { "List-Unsubscribe": "<https://u>" },
    });
  });

  test("no API key warns and skips instead of throwing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { impl, calls } = fakeFetch(200);
      const t = createResendTransport({ apiKey: undefined, from: "X <x@x.co>", fetch: impl });
      await t.send(MESSAGE, { tag: "welcome" });
      expect(calls.length).toBe(0);
      expect(warn.mock.calls[0][0]).toContain(`skipping "welcome" to dev@example.com`);
    } finally {
      warn.mockRestore();
    }
  });

  test("provider error throws with the tag and recipient", async () => {
    const { impl } = fakeFetch(422, `{"message":"invalid"}`);
    const t = createResendTransport({ apiKey: "k", from: "X <x@x.co>", fetch: impl });
    expect(t.send(MESSAGE, { tag: "verify-email" })).rejects.toThrow(
      "Resend verify-email to dev@example.com failed",
    );
  });

  test("resendTransportForBrand derives From and Reply-To", async () => {
    const { impl, calls } = fakeFetch(200);
    const t = resendTransportForBrand(
      { name: "Sapling", supportEmail: "hello@sapling.day" },
      "k",
      impl,
    );
    await t.send(MESSAGE);
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.from).toBe("Sapling <hello@sapling.day>");
    expect(body.reply_to).toBe("hello@sapling.day");
    expect(body.tags).toEqual([{ name: "template", value: "email" }]);
  });
});

describe("relay transport", () => {
  test("posts to the worker with the bearer secret", async () => {
    const { impl, calls } = fakeFetch(200);
    const t = createRelayTransport({ url: "https://sapling.day/api/email", secret: "s3", fetch: impl });
    await t.send(MESSAGE);

    expect(calls[0].input).toBe("https://sapling.day/api/email");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer s3");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      to: "dev@example.com",
      subject: "Hello",
      text: "hi",
      html: "<p>hi</p>",
    });
  });

  test("unconfigured warns and skips", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { impl, calls } = fakeFetch(200);
      const t = createRelayTransport({ url: undefined, secret: undefined, fetch: impl });
      await t.send(MESSAGE);
      expect(calls.length).toBe(0);
      expect(warn.mock.calls[0][0]).toContain(`would send "Hello" to dev@example.com`);
    } finally {
      warn.mockRestore();
    }
  });

  test("worker error surfaces status and body", async () => {
    const { impl } = fakeFetch(502, "smtp down");
    const t = createRelayTransport({ url: "https://x/api/email", secret: "s", fetch: impl });
    expect(t.send(MESSAGE)).rejects.toThrow("email relay 502: smtp down");
  });
});

describe("transportFromEnv", () => {
  const brand = { name: "Sapling", supportEmail: "hello@sapling.day" };

  test("prefers Resend when the key is set", async () => {
    const { impl, calls } = fakeFetch(200);
    const t = transportFromEnv({ RESEND_API_KEY: "k" }, brand, impl);
    await t.send(MESSAGE);
    expect(calls[0].input).toBe("https://api.resend.com/emails");
  });

  test("falls back to the relay when relay vars are set", async () => {
    const { impl, calls } = fakeFetch(200);
    const t = transportFromEnv(
      { EMAIL_RELAY_URL: "https://x/api/email", EMAIL_RELAY_SECRET: "s" },
      brand,
      impl,
    );
    await t.send(MESSAGE);
    expect(calls[0].input).toBe("https://x/api/email");
  });

  test("nothing configured yields a warn-and-skip transport", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { impl, calls } = fakeFetch(200);
      const t = transportFromEnv({}, brand, impl);
      await t.send(MESSAGE);
      expect(calls.length).toBe(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
