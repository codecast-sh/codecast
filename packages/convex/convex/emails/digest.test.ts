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
  sweep,
} from "./digest";
import { notificationDigest } from "./templates";
import { makeFakeDb } from "../testDb";

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

// ---------------------------------------------------------------------------
// Sweep: the loop and the suppression rules come from @platform/email, the
// reads and writes below them are codecast's. These cases pin that wiring —
// who gets skipped, what gets persisted, and what the delivery action is
// handed — so a change on either side of the seam shows up here.
// ---------------------------------------------------------------------------

const MIN = 60 * 1000;

function sweepCtx(over: Partial<Record<string, any[]>> = {}) {
  const tables: Record<string, any[]> = {
    users: [],
    notifications: [],
    session_decisions: [],
    user_presence: [],
    team_memberships: [],
    chat_channels: [],
    chat_reads: [],
    chat_messages: [],
    ...over,
  };
  const db = makeFakeDb(tables);
  const scheduled: any[] = [];
  const ctx = {
    db,
    scheduler: {
      runAfter: async (_ms: number, _fn: unknown, args: any) => {
        scheduled.push(args);
      },
    },
  } as any;
  return { ctx, db, tables, scheduled };
}

const ADA = "users_ada";

const user = (over: any = {}) => ({
  _id: ADA,
  email: "ada@example.com",
  name: "Ada",
  ...over,
});

const mention = (createdAt: number, over: any = {}) => ({
  _id: `notifications_${Math.random().toString(36).slice(2)}`,
  recipient_user_id: ADA,
  actor_name: "Grace",
  type: "mention",
  message: "look at this",
  read: false,
  created_at: createdAt,
  ...over,
});

const runSweep = (ctx: any) => (sweep as any)._handler(ctx, {});

describe("digest sweep", () => {
  test("an unread mention schedules one digest, mints a token, and stamps the send", async () => {
    const now = Date.now();
    const c = sweepCtx({ users: [user()], notifications: [mention(now - 20 * MIN)] });

    const res = await runSweep(c.ctx);

    expect(res).toEqual({ candidates: 1, sent: 1 });
    expect(c.scheduled.length).toBe(1);
    expect(c.scheduled[0].to).toBe("ada@example.com");
    expect(c.scheduled[0].sections[0].heading).toBe("Mentions & comments");
    expect(c.scheduled[0].sections[0].entries[0].title).toBe("**Grace** mentioned you");

    const row = c.tables.users[0];
    // A fresh token is minted, persisted, and handed to the delivery action.
    expect(row.email_unsub_token).toMatch(/^[a-z0-9]{32}$/);
    expect(c.scheduled[0].unsub_token).toBe(row.email_unsub_token);
    // The send is stamped, which is what the cooldown reads next sweep.
    expect(row.email_digest_last_sent_at).toBeGreaterThanOrEqual(now);
  });

  test("an existing unsubscribe token is reused, never re-minted", async () => {
    const now = Date.now();
    const token = "z".repeat(32);
    const c = sweepCtx({
      users: [user({ email_unsub_token: token })],
      notifications: [mention(now - 20 * MIN)],
    });

    await runSweep(c.ctx);

    expect(c.scheduled[0].unsub_token).toBe(token);
    expect(c.tables.users[0].email_unsub_token).toBe(token);
  });

  test("recent keyboard input suppresses the send", async () => {
    const now = Date.now();
    const c = sweepCtx({
      users: [user()],
      notifications: [mention(now - 20 * MIN)],
      user_presence: [{ _id: "user_presence_1", user_id: ADA, last_input_at: now - MIN }],
    });

    expect(await runSweep(c.ctx)).toEqual({ candidates: 1, sent: 0 });
    expect(c.scheduled.length).toBe(0);
    expect(c.tables.users[0].email_digest_last_sent_at).toBeUndefined();
  });

  test("cooldown suppresses a second digest", async () => {
    const now = Date.now();
    const c = sweepCtx({
      users: [user({ email_digest_last_sent_at: now - 5 * MIN })],
      notifications: [mention(now - 20 * MIN)],
    });

    expect(await runSweep(c.ctx)).toEqual({ candidates: 1, sent: 0 });
    expect(c.scheduled.length).toBe(0);
  });

  test("the master switch off suppresses the send", async () => {
    const now = Date.now();
    const c = sweepCtx({
      users: [user({ notification_preferences: { email_notifications: false } })],
      notifications: [mention(now - 20 * MIN)],
    });

    expect(await runSweep(c.ctx)).toEqual({ candidates: 1, sent: 0 });
    expect(c.scheduled.length).toBe(0);
  });

  test("a candidate whose items predate the last digest is never stamped as sent", async () => {
    const now = Date.now();
    // The notification sits in the sweep window, so this user IS a candidate,
    // and the last digest is older than the cooldown, so eligibility passes.
    // But that digest already covered this item, so the body build finds
    // nothing: no token, no stamp, no send.
    const c = sweepCtx({
      users: [user({ email_digest_last_sent_at: now - 35 * MIN })],
      notifications: [mention(now - 40 * MIN)],
    });

    expect(await runSweep(c.ctx)).toEqual({ candidates: 1, sent: 0 });
    expect(c.scheduled.length).toBe(0);
    expect(c.tables.users[0].email_digest_last_sent_at).toBe(now - 35 * MIN);
    expect(c.tables.users[0].email_unsub_token).toBeUndefined();
  });

  test("a blocked agent's pending decision leads the digest", async () => {
    const now = Date.now();
    const c = sweepCtx({
      users: [user()],
      session_decisions: [
        {
          _id: "session_decisions_1",
          user_id: ADA,
          status: "pending",
          question: "Ship the migration now or after backup?",
          options: [{ label: "now" }, { label: "after" }],
          blocking: true,
          conversation_id: "conversations_1",
          created_at: now - 20 * MIN,
        },
      ],
    });

    expect(await runSweep(c.ctx)).toEqual({ candidates: 1, sent: 1 });
    expect(c.scheduled[0].subject).toBe("An agent is blocked on your decision");
    expect(c.scheduled[0].sections[0].heading).toBe("Decisions waiting on you");
    expect(c.scheduled[0].sections[0].entries[0].linkLabel).toBe(
      "Answer — the agent is parked on this",
    );
  });

  test("a user with no email address is skipped", async () => {
    const now = Date.now();
    const c = sweepCtx({
      users: [user({ email: undefined })],
      notifications: [mention(now - 20 * MIN)],
    });

    expect(await runSweep(c.ctx)).toEqual({ candidates: 1, sent: 0 });
    expect(c.scheduled.length).toBe(0);
  });
});
