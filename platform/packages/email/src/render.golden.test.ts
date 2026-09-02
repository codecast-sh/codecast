// Golden test: with codecast's brand values, this renderer must produce
// output byte identical to codecast's convex/emails renderer. The fixture
// was dumped from codecast's own render.ts/templates.ts (working tree,
// 2026-08-21) with fixed inputs; `year` pins the footer copyright.

import { describe, expect, test } from "bun:test";
import type { Brand } from "./brand";
import { renderEmail, type EmailDef } from "./render";
import { createTemplates } from "./templates";
import golden from "./__fixtures__/codecast-golden.json";

const CODECAST: Brand = {
  name: "Codecast",
  url: "https://codecast.sh",
  tagline: "Mission control for your coding agents",
  supportEmail: "support@codecast.sh",
};

const opts = { year: golden.year };

describe("byte identical to codecast", () => {
  test("a def exercising every block kind", () => {
    const def: EmailDef = {
      subject: `All blocks <"&'>`,
      preheader: "Preview & more",
      eyebrow: "every block",
      heading: "Heading <b>",
      blocks: [
        { kind: "text", value: "Plain **bold** and [link](https://codecast.sh/x) and <i>esc</i>" },
        { kind: "code", code: "A1B2C3", hint: "expires in 15 minutes" },
        { kind: "code", code: "NOHINT" },
        { kind: "button", label: "Go & see", url: "https://codecast.sh/go?a=1&b=2" },
        { kind: "linkFallback", url: "https://codecast.sh/go?a=1&b=2" },
        {
          kind: "meta",
          rows: [
            { label: "account", value: "dev@example.com" },
            { label: "when", value: "2026-08-14 12:30 UTC" },
            { label: "device", value: "<mac>" },
          ],
        },
        {
          kind: "terminal",
          lines: [
            { text: "curl -fsSL codecast.sh/install | sh", prompt: true },
            { text: "# comment", muted: true },
            { text: "plain <line>" },
          ],
        },
        { kind: "quote", value: "line one\nline two <x>", by: "Grace" },
        { kind: "quote", value: "no by" },
        {
          kind: "item",
          title: "**Grace** mentioned you",
          excerpt: "multi\nline excerpt",
          url: "https://codecast.sh/chat/c?m=m",
          linkLabel: "Open channel",
        },
        { kind: "item", title: "No excerpt", url: "https://codecast.sh/inbox" },
        { kind: "note", value: "A note with **bold** and [settings](https://codecast.sh/settings)" },
        { kind: "subheading", value: "Mentions & comments" },
        { kind: "divider" },
      ],
      reason: "Because [you asked](https://codecast.sh/settings) and **reasons**.",
    };
    const got = renderEmail(def, CODECAST, opts);
    expect(got.subject).toBe(golden.allBlocks.subject);
    expect(got.html).toBe(golden.allBlocks.html);
    expect(got.text).toBe(golden.allBlocks.text);
  });

  const t = createTemplates(CODECAST);

  test("verifyEmail", () => {
    const got = t.verifyEmail({ code: "A1B2C3", email: "dev@example.com" }, opts);
    expect(got).toEqual(golden.verifyEmail);
  });

  test("passwordReset", () => {
    const got = t.passwordReset({ code: "X9Y8Z7", email: "dev@example.com" }, opts);
    expect(got).toEqual(golden.passwordReset);
  });

  test("passwordChanged", () => {
    const got = t.passwordChanged({ email: "dev@example.com", changedAt: 1755172800000 }, opts);
    expect(got).toEqual(golden.passwordChanged);
  });

  // Codecast's welcome copy, supplied as parameters to the generic template.
  const codecastWelcome = (name?: string) =>
    t.welcome(
      {
        email: "dev@example.com",
        name,
        subject: "Welcome to Codecast — your agents, on air",
        preheader: "Connect your machine and every coding agent session lands in one inbox.",
        heading: "You're on the air",
        intro:
          "Codecast is mission control for your coding agents: every Claude Code and Codex session on your machines streams into one live inbox, where you can read, steer, and hand off work from anywhere.",
        blocks: [
          { kind: "text", value: "Connect your first machine — one command, about a minute:" },
          {
            kind: "terminal",
            lines: [
              { text: "curl -fsSL codecast.sh/install | sh", prompt: true },
              { text: "cast", prompt: true },
              { text: "# your sessions appear at codecast.sh/inbox", muted: true },
            ],
          },
          {
            kind: "text",
            value:
              "From there: search every past session like a shared memory, message any running agent, publish pages and dashboards straight from a conversation, and invite your team to see it all live.",
          },
        ],
        cta: { label: "Open your inbox", url: "https://codecast.sh/inbox" },
      },
      opts,
    );

  test("welcome with a name", () => {
    expect(codecastWelcome("  Ada ")).toEqual(golden.welcomeNamed);
  });

  test("welcome without a name", () => {
    expect(codecastWelcome(undefined)).toEqual(golden.welcomeAnon);
  });
});
