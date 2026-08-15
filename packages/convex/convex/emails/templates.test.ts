import { describe, expect, test } from "bun:test";
import { renderEmail, escapeHtml, type RenderedEmail } from "./render";
import {
  artifactComment,
  passwordChanged,
  passwordReset,
  teamInvite,
  verifyEmail,
  welcome,
} from "./templates";

const ALL: Array<{ name: string; email: RenderedEmail }> = [
  { name: "verifyEmail", email: verifyEmail({ code: "A1B2C3", email: "dev@example.com" }) },
  { name: "passwordReset", email: passwordReset({ code: "X9Y8Z7", email: "dev@example.com" }) },
  {
    name: "passwordChanged",
    email: passwordChanged({ email: "dev@example.com", changedAt: 1755172800000 }),
  },
  { name: "welcome", email: welcome({ email: "dev@example.com", name: "Ada" }) },
  {
    name: "teamInvite",
    email: teamInvite({
      inviterName: "Ada Lovelace",
      inviterEmail: "ada@example.com",
      teamName: "Analytical Engines",
      inviteUrl: "https://codecast.sh/join/ABCD1234",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    }),
  },
  {
    name: "artifactComment",
    email: artifactComment({
      pageTitle: "Q3 Growth Report",
      pageUrl: "https://codecast.sh/a/q3-growth",
      commenterName: "Grace",
      commentText: "The retention chart is missing August.",
      ownerEmail: "dev@example.com",
    }),
  },
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
      // Outlook dark-mode attribute selectors present.
      expect(email.html).toContain("[data-ogsc]");

      // The wordmark and footer are part of the shared layout.
      expect(email.html).toContain("codecast");
      expect(email.html).toContain("codecast.sh");

      // Only https links.
      const hrefs = [...email.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href).toStartWith("https://");
      }

      // Plain-text twin exists and carries no HTML.
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
    const e = verifyEmail({ code: "K4M7PQ", email: "dev@example.com" });
    expect(e.subject).toStartWith("K4M7PQ");
    expect(e.html).toContain("K4M7PQ");
    expect(e.text).toContain("K4M7PQ");
  });

  test("reset code appears in preheader, body, and text", () => {
    const e = passwordReset({ code: "R3S3TT", email: "dev@example.com" });
    expect(e.html).toContain("R3S3TT");
    expect(e.text).toContain("R3S3TT");
  });
});

describe("escaping", () => {
  test("hostile team and inviter names cannot inject HTML", () => {
    const e = teamInvite({
      inviterName: `<script>alert(1)</script>`,
      teamName: `"><img src=x onerror=alert(1)>`,
      inviteUrl: "https://codecast.sh/join/CODE",
    });
    expect(e.html).not.toContain("<script>");
    expect(e.html).not.toContain("<img");
    expect(e.html).toContain("&lt;script&gt;");
  });

  test("hostile comment text is escaped and long comments are trimmed", () => {
    const e = artifactComment({
      pageTitle: "T",
      pageUrl: "https://codecast.sh/a/t",
      commenterName: "X",
      commentText: `<b>hi</b>` + "y".repeat(500),
      ownerEmail: "o@example.com",
    });
    expect(e.html).not.toContain("<b>hi</b>");
    expect(e.html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    expect(e.html).toContain("…");
  });

  test("user text cannot smuggle a link through the marker syntax", () => {
    // Markers expand only for https URLs written by our templates; a
    // javascript: payload in user text must stay inert.
    const e = renderEmail({
      subject: "s",
      preheader: "p",
      heading: "h",
      blocks: [{ kind: "text", value: "[click](javascript:alert(1))" }],
      reason: "r",
    });
    expect(e.html).not.toContain('href="javascript:');
  });

  test("escapeHtml covers the five metacharacters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("content specifics", () => {
  test("security notice shows account and UTC timestamp", () => {
    const e = passwordChanged({ email: "dev@example.com", changedAt: Date.UTC(2026, 7, 14, 12, 30) });
    expect(e.html).toContain("2026-08-14 12:30 UTC");
    expect(e.text).toContain("dev@example.com");
  });

  test("welcome carries the install command and the inbox CTA", () => {
    const e = welcome({ email: "dev@example.com" });
    expect(e.html).toContain("curl -fsSL codecast.sh/install | sh");
    expect(e.html).toContain("https://codecast.sh/inbox");
    expect(e.text).toContain("curl -fsSL codecast.sh/install | sh");
  });

  test("invite renders the join URL and expiry in days", () => {
    const e = teamInvite({
      inviterName: "Ada",
      teamName: "Engines",
      inviteUrl: "https://codecast.sh/join/ZZZZ",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });
    expect(e.html).toContain("https://codecast.sh/join/ZZZZ");
    expect(e.text).toContain("https://codecast.sh/join/ZZZZ");
    expect(e.html).toContain("expires in 7 days");
  });

  test("preheader is present but hidden", () => {
    const e = passwordReset({ code: "AAAAAA", email: "d@e.com" });
    expect(e.html).toMatch(/display:none[^>]*>Your reset code is AAAAAA/);
  });
});
