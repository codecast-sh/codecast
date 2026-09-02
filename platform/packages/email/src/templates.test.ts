// Structural and escaping invariants for the generic templates, ported from
// codecast's templates.test.ts (the parts that apply to the four templates
// living here).

import { describe, expect, test } from "bun:test";
import type { Brand } from "./brand";
import { renderEmail, escapeHtml, type RenderedEmail } from "./render";
import { createTemplates } from "./templates";

const BRAND: Brand = {
  name: "Sapling",
  url: "https://sapling.day",
  tagline: "A calm home for your plants",
  supportEmail: "hello@sapling.day",
};

const t = createTemplates(BRAND);

const ALL: Array<{ name: string; email: RenderedEmail }> = [
  { name: "verifyEmail", email: t.verifyEmail({ code: "A1B2C3", email: "dev@example.com" }) },
  { name: "passwordReset", email: t.passwordReset({ code: "X9Y8Z7", email: "dev@example.com" }) },
  {
    name: "passwordChanged",
    email: t.passwordChanged({ email: "dev@example.com", changedAt: 1755172800000 }),
  },
  { name: "welcome", email: t.welcome({ email: "dev@example.com", name: "Ada" }) },
];

describe("every template", () => {
  for (const { name, email } of ALL) {
    test(`${name}: structural invariants`, () => {
      // Subject exists and never leaks markup.
      expect(email.subject.length).toBeGreaterThan(8);
      expect(email.subject).not.toMatch(/[<>]/);

      // Full document with both color schemes declared.
      expect(email.html).toStartWith("<!DOCTYPE html>");
      expect(email.html).toContain('name="color-scheme" content="light dark"');
      expect(email.html).toContain("prefers-color-scheme: dark");
      // Outlook dark mode attribute selectors present.
      expect(email.html).toContain("[data-ogsc]");

      // The brand's wordmark and footer are part of the shared layout.
      expect(email.html).toContain("sapling");
      expect(email.html).toContain("sapling.day");

      // Only https links.
      const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href).toStartWith("https://");
      }

      // Plain text twin exists and carries no HTML.
      expect(email.text.length).toBeGreaterThan(40);
      expect(email.text).not.toMatch(/<[a-z]+[\s>]/i);

      // No leftover marker syntax in rendered output.
      expect(email.html).not.toContain("**");
      expect(email.text).not.toContain("**");
      // No unresolved template interpolation.
      expect(email.html).not.toContain("${");
      expect(email.html).not.toContain("undefined");
    });
  }
});

describe("codes", () => {
  test("verification code leads the subject and appears in both parts", () => {
    const e = t.verifyEmail({ code: "K4M7PQ", email: "dev@example.com" });
    expect(e.subject).toStartWith("K4M7PQ");
    expect(e.html).toContain("K4M7PQ");
    expect(e.text).toContain("K4M7PQ");
  });

  test("reset code appears in preheader, body, and text", () => {
    const e = t.passwordReset({ code: "R3S3TT", email: "dev@example.com" });
    expect(e.html).toContain("R3S3TT");
    expect(e.text).toContain("R3S3TT");
  });

  test("expiry minutes are configurable", () => {
    const e = t.verifyEmail({ code: "AAAAAA", email: "d@e.com", expiryMinutes: 5 });
    expect(e.html).toContain("expires in 5 minutes");
  });
});

describe("escaping", () => {
  test("hostile user text cannot inject HTML", () => {
    const e = renderEmail(
      {
        subject: "s",
        preheader: "p",
        heading: "h",
        blocks: [{ kind: "text", value: `<script>alert(1)</script>` }],
        reason: "r",
      },
      BRAND,
    );
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
  });

  test("user text cannot smuggle a link through the marker syntax", () => {
    // Markers expand only for https URLs written by our templates; a
    // javascript: payload in user text must stay inert.
    const e = renderEmail(
      {
        subject: "s",
        preheader: "p",
        heading: "h",
        blocks: [{ kind: "text", value: "[click](javascript:alert(1))" }],
        reason: "r",
      },
      BRAND,
    );
    expect(e.html).not.toContain('href="javascript:');
  });

  test("escapeHtml covers the five metacharacters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("content specifics", () => {
  test("security notice shows account and UTC timestamp", () => {
    const e = t.passwordChanged({
      email: "dev@example.com",
      changedAt: Date.UTC(2026, 7, 14, 12, 30),
    });
    expect(e.html).toContain("2026-08-14 12:30 UTC");
    expect(e.text).toContain("dev@example.com");
  });

  test("passwordChanged points at the brand's reset page by default", () => {
    const e = t.passwordChanged({ email: "d@e.com", changedAt: 0 });
    expect(e.html).toContain("https://sapling.day/forgot-password");
  });

  test("welcome defaults derive from the brand", () => {
    const e = t.welcome({ email: "dev@example.com" });
    expect(e.subject).toBe("Welcome to Sapling");
    expect(e.text).toContain("Sapling is a calm home for your plants.");
    expect(e.html).toContain("hello@sapling.day");
  });

  test("preheader is present but hidden", () => {
    const e = t.passwordReset({ code: "AAAAAA", email: "d@e.com" });
    expect(e.html).toMatch(/display:none[^>]*>Your reset code is AAAAAA/);
  });
});
