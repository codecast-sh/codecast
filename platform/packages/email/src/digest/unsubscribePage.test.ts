import { describe, expect, test } from "bun:test";
import { unsubscribeResponse } from "./unsubscribePage";

const BRAND = {
  name: "Sapling",
  url: "https://sapling.day",
  tagline: "A calm home for your plants",
  supportEmail: "hello@sapling.day",
};
const settingsUrl = "https://sapling.day/settings/notifications";

describe("unsubscribeResponse", () => {
  test("POST answers RFC 8058 one click with plain text", async () => {
    const ok = unsubscribeResponse({ ok: true, method: "POST", brand: BRAND, settingsUrl });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("ok");
    const bad = unsubscribeResponse({ ok: false, method: "POST", brand: BRAND, settingsUrl });
    expect(bad.status).toBe(404);
    expect(await bad.text()).toBe("unknown token");
  });

  test("GET serves a branded confirmation page", async () => {
    const res = unsubscribeResponse({ ok: true, method: "GET", brand: BRAND, settingsUrl });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("You're unsubscribed");
    expect(html).toContain("Sapling will no longer email you");
    expect(html).toContain(settingsUrl);
  });

  test("GET with a dead token serves the expired page as 404", async () => {
    const res = unsubscribeResponse({ ok: false, method: "GET", brand: BRAND, settingsUrl });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Link expired");
  });
});
