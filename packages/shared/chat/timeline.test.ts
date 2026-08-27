import { describe, expect, it } from "bun:test";
import {
  GROUP_WINDOW_MS,
  buildChatTimeline,
  dayLabel,
  QUIET_TOAST_BURST_CAP,
  chatToastTier,
  shouldToastChatMessage,
  tallyUnread,
  type TimelineMessage,
} from "./timeline";

// The chat timeline is shared verbatim by web and mobile, and mobile runs no CI,
// so these tests are the only thing standing behind the grouping and unread rules
// on that platform.

const DAY = 86_400_000;
const MIN = 60_000;
// A fixed local wall clock. Day boundaries are local, so a UTC instant would make
// these assertions depend on the machine's timezone.
const NOW = new Date("2026-08-12T15:00:00").getTime();

const msg = (id: string, authorId: string, createdAt: number, extra: Partial<TimelineMessage> = {}): TimelineMessage => ({
  id,
  authorId,
  createdAt,
  ...extra,
});

const kinds = (rows: ReturnType<typeof buildChatTimeline>) => rows.map((r) => r.kind);
const groupedFlags = (rows: ReturnType<typeof buildChatTimeline>) =>
  rows.filter((r) => r.kind === "message").map((r) => (r as any).grouped);

describe("buildChatTimeline — grouping", () => {
  it("groups consecutive messages by one author inside the window", () => {
    const rows = buildChatTimeline(
      [msg("a", "u1", NOW - 3 * MIN), msg("b", "u1", NOW - 2 * MIN), msg("c", "u1", NOW - MIN)],
      { now: NOW },
    );
    expect(groupedFlags(rows)).toEqual([false, true, true]);
  });

  it("breaks the group when the author changes", () => {
    const rows = buildChatTimeline([msg("a", "u1", NOW - 2 * MIN), msg("b", "u2", NOW - MIN)], { now: NOW });
    expect(groupedFlags(rows)).toEqual([false, false]);
  });

  it("breaks the group once the gap exceeds the window", () => {
    const justInside = buildChatTimeline(
      [msg("a", "u1", NOW - GROUP_WINDOW_MS), msg("b", "u1", NOW)],
      { now: NOW },
    );
    expect(groupedFlags(justInside)).toEqual([false, true]);

    const justOutside = buildChatTimeline(
      [msg("a", "u1", NOW - GROUP_WINDOW_MS - 1), msg("b", "u1", NOW)],
      { now: NOW },
    );
    expect(groupedFlags(justOutside)).toEqual([false, false]);
  });

  it("never groups a deleted message, in either direction", () => {
    // "This message was deleted" folded under the header above reads as a
    // continuation of that person's sentence.
    const rows = buildChatTimeline(
      [
        msg("a", "u1", NOW - 3 * MIN),
        msg("b", "u1", NOW - 2 * MIN, { deleted: true }),
        msg("c", "u1", NOW - MIN),
      ],
      { now: NOW },
    );
    expect(groupedFlags(rows)).toEqual([false, false, false]);
  });

  it("never groups an agent placeholder, in either direction", () => {
    // It is about to change height; grouping it makes the list jump on answer.
    const rows = buildChatTimeline(
      [
        msg("a", "bot", NOW - 3 * MIN),
        msg("b", "bot", NOW - 2 * MIN, { pendingAgent: true }),
        msg("c", "bot", NOW - MIN),
      ],
      { now: NOW },
    );
    expect(groupedFlags(rows)).toEqual([false, false, false]);
  });

  it("never groups a standalone system row, in either direction", () => {
    // A huddle digest renders under its own header; folding the author's next
    // message under it would leave that message headerless.
    const rows = buildChatTimeline(
      [
        msg("a", "u1", NOW - 3 * MIN),
        msg("b", "u1", NOW - 2 * MIN, { standalone: true }),
        msg("c", "u1", NOW - MIN),
      ],
      { now: NOW },
    );
    expect(groupedFlags(rows)).toEqual([false, false, false]);
  });
});

describe("buildChatTimeline — day separators", () => {
  it("emits one separator per day and breaks the group across midnight", () => {
    const rows = buildChatTimeline(
      [msg("a", "u1", NOW - DAY), msg("b", "u1", NOW - DAY + MIN), msg("c", "u1", NOW)],
      { now: NOW },
    );
    expect(kinds(rows)).toEqual(["day", "message", "message", "day", "message"]);
    // Same author, but a day boundary intervened, so the run restarts.
    expect(groupedFlags(rows)).toEqual([false, true, false]);
  });

  it("omits separators when asked, for the thread panel", () => {
    const rows = buildChatTimeline([msg("a", "u1", NOW - DAY), msg("b", "u1", NOW)], {
      now: NOW,
      withoutDays: true,
    });
    expect(kinds(rows)).toEqual(["message", "message"]);
  });

  it("labels today and yesterday by name", () => {
    expect(dayLabel(NOW, NOW)).toBe("Today");
    expect(dayLabel(NOW - DAY, NOW)).toBe("Yesterday");
    expect(dayLabel(NOW - 5 * DAY, NOW)).not.toBe("Today");
  });

  it("returns nothing at all for an empty channel", () => {
    expect(buildChatTimeline([], { now: NOW })).toEqual([]);
  });
});

describe("buildChatTimeline — the unread rule", () => {
  it("draws the rule once, before the first unread message", () => {
    const rows = buildChatTimeline(
      [
        msg("a", "u2", NOW - 10 * MIN),
        msg("b", "u2", NOW - 4 * MIN),
        msg("c", "u2", NOW - 3 * MIN),
      ],
      { now: NOW, lastReadAt: NOW - 5 * MIN, viewerId: "me" },
    );
    expect(kinds(rows)).toEqual(["day", "message", "new", "message", "message"]);
  });

  it("breaks the group at the rule, so the first unread carries a header", () => {
    const rows = buildChatTimeline(
      [msg("a", "u2", NOW - 4 * MIN), msg("b", "u2", NOW - 3 * MIN)],
      { now: NOW, lastReadAt: NOW - 3.5 * MIN, viewerId: "me" },
    );
    expect(groupedFlags(rows)).toEqual([false, false]);
  });

  it("does not let the viewer's own message trigger the rule", () => {
    // Sending is reading. A rule above your own message is nonsense.
    const rows = buildChatTimeline(
      [msg("a", "me", NOW - 2 * MIN), msg("b", "u2", NOW - MIN)],
      { now: NOW, lastReadAt: NOW - 3 * MIN, viewerId: "me" },
    );
    const newIndex = rows.findIndex((r) => r.kind === "new");
    const firstOther = rows.findIndex((r) => r.kind === "message" && (r as any).message.authorId === "u2");
    expect(newIndex).toBeGreaterThan(-1);
    expect(newIndex).toBe(firstOther - 1);
  });

  it("draws no rule when everything has been read", () => {
    const rows = buildChatTimeline([msg("a", "u2", NOW - 10 * MIN)], {
      now: NOW,
      lastReadAt: NOW,
      viewerId: "me",
    });
    expect(kinds(rows)).not.toContain("new");
  });

  it("draws no rule when read state is unknown, rather than marking everything unread", () => {
    const rows = buildChatTimeline([msg("a", "u2", NOW - 10 * MIN)], { now: NOW, viewerId: "me" });
    expect(kinds(rows)).not.toContain("new");
  });
});

describe("tallyUnread", () => {
  const m = (createdAt: number, authorId: string, extra: any = {}) => ({ createdAt, authorId, ...extra });

  it("counts only other people's messages after the read mark", () => {
    const t = tallyUnread(
      [m(NOW - 10 * MIN, "u2"), m(NOW - MIN, "u2"), m(NOW - MIN, "me")],
      NOW - 5 * MIN,
      "me",
    );
    expect(t).toEqual({ unread: 1, mentions: 0 });
  });

  it("counts mentions as a subset of unread", () => {
    const t = tallyUnread(
      [m(NOW - MIN, "u2", { mentionsViewer: true }), m(NOW - MIN, "u2")],
      NOW - 5 * MIN,
      "me",
    );
    expect(t).toEqual({ unread: 2, mentions: 1 });
  });

  it("ignores tombstones, so deleting a message clears its badge", () => {
    const t = tallyUnread([m(NOW - MIN, "u2", { deletedAt: NOW })], NOW - 5 * MIN, "me");
    expect(t).toEqual({ unread: 0, mentions: 0 });
  });

  it("ignores a burst still being spoken: the badge waits for the release", () => {
    const talking = tallyUnread(
      [m(NOW - MIN, "u2", { voiceLive: true, mentionsViewer: true })], NOW - 5 * MIN, "me",
    );
    expect(talking).toEqual({ unread: 0, mentions: 0 });
    const released = tallyUnread(
      [m(NOW - MIN, "u2", { mentionsViewer: true })], NOW - 5 * MIN, "me",
    );
    expect(released).toEqual({ unread: 1, mentions: 1 });
  });

  it("treats a never-read channel as entirely unread", () => {
    const t = tallyUnread([m(NOW - DAY, "u2"), m(NOW, "u2")], undefined, "me");
    expect(t.unread).toBe(2);
  });
});

describe("chatToastTier", () => {
  // Elsewhere, so the channel on screen never suppresses the case under test.
  const base = {
    authorId: "u2",
    viewerId: "me",
    channelId: "c1",
    activeChannelId: "c2",
    windowFocused: true,
  };

  it("gives ordinary chatter a quiet toast", () => {
    expect(chatToastTier(base)).toBe("quiet");
  });

  it("never toasts your own message", () => {
    expect(chatToastTier({ ...base, authorId: "me" })).toBe("silent");
  });

  describe("what is loud", () => {
    it("a direct mention", () => {
      expect(chatToastTier({ ...base, mentionsViewer: true })).toBe("loud");
    });

    it("an agent answering the question you asked", () => {
      expect(chatToastTier({ ...base, answersViewer: true })).toBe("loud");
    });

    it("a reply on a thread you are part of", () => {
      expect(chatToastTier({ ...base, threadRootId: "m1", viewerInThread: true })).toBe("loud");
    });

    it("but not a reply on a thread you are not part of", () => {
      expect(chatToastTier({ ...base, threadRootId: "m1" })).toBe("quiet");
    });

    it("every line of a direct message", () => {
      expect(chatToastTier({ ...base, isDm: true })).toBe("loud");
      // Even at the "mentions" default a DM line is addressed to you.
      expect(chatToastTier({ ...base, isDm: true, notifyLevel: "mentions" })).toBe("loud");
    });
  });

  describe("direct messages and the mute", () => {
    it("a muted DM is actually silent — a mention cannot ride through", () => {
      expect(chatToastTier({ ...base, isDm: true, notifyLevel: "none" })).toBe("silent");
      expect(chatToastTier({ ...base, isDm: true, channelMuted: true, mentionsViewer: true })).toBe("silent");
    });

    it("a DM you are looking at stays quiet on screen", () => {
      expect(
        chatToastTier({ ...base, isDm: true, activeChannelId: "c1", windowFocused: true }),
      ).toBe("silent");
    });
  });

  describe("what is already on screen", () => {
    it("stays silent about the focused channel", () => {
      expect(chatToastTier({ ...base, activeChannelId: "c1" })).toBe("silent");
    });

    it("outranks a mention, because you are looking straight at it", () => {
      expect(chatToastTier({ ...base, activeChannelId: "c1", mentionsViewer: true })).toBe("silent");
    });

    it("still toasts when the window is not focused", () => {
      expect(chatToastTier({ ...base, activeChannelId: "c1", windowFocused: false })).toBe("quiet");
    });

    it("toasts a thread reply while the thread panel is closed", () => {
      expect(chatToastTier({ ...base, activeChannelId: "c1", threadRootId: "m1" })).toBe("quiet");
    });

    it("stays silent about the thread the viewer has open", () => {
      expect(
        chatToastTier({ ...base, activeChannelId: "c1", activeThreadRootId: "m1", threadRootId: "m1" }),
      ).toBe("silent");
    });
  });

  describe("mute, level and do not disturb", () => {
    it("silences ordinary messages in a muted channel", () => {
      expect(chatToastTier({ ...base, channelMuted: true })).toBe("silent");
    });

    it("lets a direct mention pierce a muted channel", () => {
      // Muting a room is not asking not to be spoken to.
      expect(chatToastTier({ ...base, channelMuted: true, mentionsViewer: true })).toBe("loud");
    });

    it("honours the mentions-only level in both directions", () => {
      expect(chatToastTier({ ...base, notifyLevel: "mentions" })).toBe("silent");
      expect(chatToastTier({ ...base, notifyLevel: "mentions", mentionsViewer: true })).toBe("loud");
    });

    it("honours the none level even for a mention", () => {
      expect(chatToastTier({ ...base, notifyLevel: "none", mentionsViewer: true })).toBe("silent");
    });

    it("lets do-not-disturb outrank a mention", () => {
      expect(chatToastTier({ ...base, doNotDisturb: true, mentionsViewer: true })).toBe("silent");
    });
  });

  describe("the burst gate", () => {
    it("drops a busy channel to a badge once it passes the cap", () => {
      expect(chatToastTier({ ...base, recentToastsFromChannel: QUIET_TOAST_BURST_CAP - 1 })).toBe("quiet");
      expect(chatToastTier({ ...base, recentToastsFromChannel: QUIET_TOAST_BURST_CAP })).toBe("silent");
    });

    it("never rate limits being named — that is not chatter", () => {
      expect(
        chatToastTier({ ...base, recentToastsFromChannel: 99, mentionsViewer: true }),
      ).toBe("loud");
    });
  });

  it("shouldToastChatMessage agrees with the tier", () => {
    expect(shouldToastChatMessage({ ...base, mentionsViewer: true })).toBe(true);
    expect(shouldToastChatMessage(base)).toBe(true);
    expect(shouldToastChatMessage({ ...base, doNotDisturb: true })).toBe(false);
  });
});

describe("tallyUnread thread semantics", () => {
  it("mirrors the server: replies do not tick unread, mentions count anywhere", () => {
    const t = tallyUnread(
      [
        { createdAt: NOW - MIN, authorId: "u2" },
        { createdAt: NOW - MIN, authorId: "u2", threadRootId: "r1" },
        { createdAt: NOW - MIN, authorId: "u2", threadRootId: "r1", mentionsViewer: true },
      ],
      NOW - 5 * MIN,
      "me",
    );
    expect(t).toEqual({ unread: 1, mentions: 1 });
  });
});
