import { describe, expect, test } from "bun:test";
import {
  ACTIVE_MS,
  COOLDOWN_MS,
  EMAIL_WORTHY,
  countableChatMessage,
  digestEligible,
  digestSubject,
  entityUrl,
  notificationEntry,
} from "./digest";
import { notificationDigest } from "./templates";

const NOW = 1_800_000_000_000;

describe("EMAIL_WORTHY", () => {
  test("session-state noise is structurally excluded", () => {
    for (const noisy of [
      "session_idle",
      "session_error",
      "permission_request",
      "team_session_start",
      "task_status_changed",
      "task_completed",
      "task_failed",
      "doc_updated",
      "plan_status_changed",
      "plan_task_completed",
    ]) {
      expect(EMAIL_WORTHY.has(noisy)).toBe(false);
    }
  });

  test("direct, personal types are included", () => {
    for (const t of ["mention", "comment_reply", "chat_mention", "task_assigned", "team_invite"]) {
      expect(EMAIL_WORTHY.has(t)).toBe(true);
    }
  });
});

describe("digestEligible", () => {
  test("unsubscribed never sends", () => {
    expect(digestEligible({ emailPref: false, lastSentAt: undefined, lastInputAt: undefined, now: NOW }).send).toBe(false);
  });
  test("absent preference reads as on", () => {
    expect(digestEligible({ emailPref: undefined, lastSentAt: undefined, lastInputAt: undefined, now: NOW }).send).toBe(true);
  });
  test("recent keyboard input suppresses", () => {
    const r = digestEligible({ emailPref: true, lastSentAt: undefined, lastInputAt: NOW - ACTIVE_MS + 1000, now: NOW });
    expect(r).toEqual({ send: false, reason: "active" });
  });
  test("input older than ACTIVE_MS does not suppress", () => {
    expect(digestEligible({ emailPref: true, lastSentAt: undefined, lastInputAt: NOW - ACTIVE_MS - 1000, now: NOW }).send).toBe(true);
  });
  test("cooldown suppresses a second digest", () => {
    const r = digestEligible({ emailPref: true, lastSentAt: NOW - COOLDOWN_MS + 60_000, lastInputAt: undefined, now: NOW });
    expect(r).toEqual({ send: false, reason: "cooldown" });
  });
  test("cooldown elapsed allows", () => {
    expect(digestEligible({ emailPref: true, lastSentAt: NOW - COOLDOWN_MS - 1, lastInputAt: undefined, now: NOW }).send).toBe(true);
  });
});

describe("entityUrl", () => {
  const site = "https://codecast.sh";
  test("explicit link wins", () => {
    expect(entityUrl(site, { link: "https://codecast.sh/a/x?c=1", entity_type: "task", entity_id: "t1" })).toBe("https://codecast.sh/a/x?c=1");
  });
  test("task/doc/plan routes", () => {
    expect(entityUrl(site, { entity_type: "task", entity_id: "t1" })).toBe("https://codecast.sh/tasks/t1");
    expect(entityUrl(site, { entity_type: "doc", entity_id: "d1" })).toBe("https://codecast.sh/docs/d1");
    expect(entityUrl(site, { entity_type: "plan", entity_id: "p1" })).toBe("https://codecast.sh/plans/p1");
  });
  test("chat deep-links to the message", () => {
    expect(entityUrl(site, { entity_type: "chat_channel", entity_id: "c1", chat_message_id: "m9" })).toBe("https://codecast.sh/chat/c1?m=m9");
    expect(entityUrl(site, { entity_type: "chat_channel", entity_id: "c1" })).toBe("https://codecast.sh/chat/c1");
  });
  test("conversation fallback, then notifications page", () => {
    expect(entityUrl(site, { conversation_id: "cv1" })).toBe("https://codecast.sh/conversation/cv1");
    expect(entityUrl(site, {})).toBe("https://codecast.sh/notifications");
  });
});

describe("notificationEntry", () => {
  test("names the actor and action, trims long messages", () => {
    const e = notificationEntry("https://codecast.sh", {
      type: "chat_mention",
      message: "x".repeat(300),
      actor: "Grace",
      entity_type: "chat_channel",
      entity_id: "c1",
    });
    expect(e.title).toBe("**Grace** mentioned you in chat");
    expect(e.excerpt!.length).toBe(241);
    expect(e.excerpt!.endsWith("…")).toBe(true);
  });
  test("unknown actor falls back to Someone", () => {
    expect(notificationEntry("https://codecast.sh", { type: "mention", message: "hi" }).title).toBe("**Someone** mentioned you");
  });
});

describe("digestSubject", () => {
  test("blocking decisions lead", () => {
    const s = digestSubject({ blockingDecisions: 2, advisoryDecisions: 0, personalCount: 5, chatChannels: [], chatCount: 0 });
    expect(s.subject).toBe("2 agents are blocked on your decisions");
    expect(s.preheader).toContain("2 decisions");
  });
  test("single blocking decision is singular", () => {
    expect(digestSubject({ blockingDecisions: 1, advisoryDecisions: 0, personalCount: 0, chatChannels: [], chatCount: 0 }).subject).toBe("An agent is blocked on your decision");
  });
  test("personal item leads with the actor line and a count of the rest", () => {
    const s = digestSubject({
      blockingDecisions: 0,
      advisoryDecisions: 0,
      firstPersonalTitle: "**Grace** mentioned you",
      personalCount: 3,
      chatChannels: ["general"],
      chatCount: 4,
    });
    expect(s.subject).toBe("Grace mentioned you — and 6 more");
    expect(s.subject).not.toContain("**");
  });
  test("chat-only subject names the channel", () => {
    expect(digestSubject({ blockingDecisions: 0, advisoryDecisions: 0, personalCount: 0, chatChannels: ["design"], chatCount: 7 }).subject).toBe("7 unread messages in #design");
  });
});

describe("countableChatMessage", () => {
  test("mirrors chat.ts channel-unread rules", () => {
    expect(countableChatMessage({ user_id: "other" }, "me")).toBe(true);
    expect(countableChatMessage({ user_id: "me" }, "me")).toBe(false);
    expect(countableChatMessage({ user_id: "other", deleted_at: 1 }, "me")).toBe(false);
    expect(countableChatMessage({ user_id: "other", thread_root_id: "root" }, "me")).toBe(false);
  });
});

describe("notificationDigest template", () => {
  test("renders sections, entries, more-count, unsubscribe", () => {
    const e = notificationDigest({
      subject: "Grace mentioned you — and 2 more",
      preheader: "Waiting for you: 3 mentions & comments.",
      sections: [
        {
          heading: "Decisions waiting on you",
          entries: [{ title: "**Ship the migration now or after backup?**", excerpt: "Backup runs at 02:00 UTC.", url: "https://codecast.sh/conversation/x", linkLabel: "Answer" }],
        },
        {
          heading: "Mentions & comments",
          entries: [{ title: "**Grace** mentioned you", excerpt: "<b>can</b> you look?", url: "https://codecast.sh/chat/c?m=m" }],
        },
      ],
      moreCount: 4,
      settingsUrl: "https://codecast.sh/settings/notifications",
      unsubscribeUrl: "https://convex.codecast.sh/cli/email/unsubscribe?token=abc",
    });
    expect(e.html).toContain("DECISIONS WAITING ON YOU");
    expect(e.html).toContain("Ship the migration now or after backup?");
    expect(e.html).toContain("&lt;b&gt;can&lt;/b&gt;");
    expect(e.html).not.toContain("<b>can</b>");
    expect(e.html).toContain("and 4 more");
    expect(e.html).toContain('href="https://convex.codecast.sh/cli/email/unsubscribe?token=abc"');
    expect(e.text).toContain("* Grace mentioned you");
    expect(e.text).toContain("https://codecast.sh/chat/c?m=m");
    expect(e.text).toContain("Unsubscribe (https://convex.codecast.sh/cli/email/unsubscribe?token=abc)");
  });
});
