import { describe, expect, test } from "bun:test";
import {
  decodeSlackEntities,
  emojiToShortcode,
  markdownToSlack,
  replaceShortcodes,
  shortcodeToEmoji,
  slackAttachmentsToMarkdown,
  slackDisplayName,
  slackToMarkdown,
} from "./slackText";

const users: Record<string, { handle?: string | null; name?: string | null }> = {
  U1: { handle: "ashot", name: "Ashot Petrosian" },
  U2: { name: "Jordan Belman" },
};
const resolve = {
  user: (id: string) => users[id] ?? null,
  channel: (id: string) => (id === "C9" ? "general" : null),
  usergroup: (id: string) => (id === "S1" ? "eng" : null),
};

describe("slackToMarkdown", () => {
  test("mapped mention becomes a codecast handle, unmapped becomes guarded bold", () => {
    expect(slackToMarkdown("hi <@U1> and <@U2>", resolve)).toBe("hi @ashot and **@​Jordan Belman**");
  });
  test("an unknown user id with a label uses the label", () => {
    expect(slackToMarkdown("<@U7|dana>", resolve)).toBe("**@​dana**");
  });
  test("the guarded bold never satisfies the mention grammar", () => {
    const out = slackToMarkdown("<@U2>", resolve);
    expect(/(?:^|[^\w/])@([A-Za-z0-9][A-Za-z0-9_-]{0,38})/.test(out)).toBe(false);
  });
  test("channels, here, groups, dates", () => {
    expect(slackToMarkdown("see <#C9|general> and <#C9> <!here> <!channel> <!subteam^S1|@eng>", resolve))
      .toBe("see #general and #general @here @here **@​eng**");
    expect(slackToMarkdown("<!date^1700000000^{date_short}|Nov 14>", resolve)).toBe("Nov 14");
  });
  test("links", () => {
    expect(slackToMarkdown("<https://a.b/x|docs> <https://a.b/y> <mailto:a@b.c|a@b.c>", resolve))
      .toBe("[docs](https://a.b/x) https://a.b/y a@b.c");
  });
  test("formatting", () => {
    expect(slackToMarkdown("*bold* _it_ ~gone~ and snake_case_word stays", resolve))
      .toBe("**bold** *it* ~~gone~~ and snake_case_word stays");
    expect(slackToMarkdown("2 * 3 * 4 = 24", resolve)).toBe("2 * 3 * 4 = 24");
  });
  test("entities decode outside and inside code, code is untouched", () => {
    expect(slackToMarkdown("a &amp; b &lt;c&gt; `x &lt; *y*` ```*z* &amp;```", resolve))
      .toBe("a & b <c> `x < *y*` ```*z* &```");
  });
  test("quotes, bullets, and a leading hash", () => {
    expect(slackToMarkdown("&gt; quoted\n• one\n• two\n# not a header", resolve))
      .toBe("> quoted\n- one\n- two\n\\# not a header");
  });
  test("emoji shortcodes with and without skin tones", () => {
    expect(slackToMarkdown("ship it :rocket: :+1::skin-tone-3: :unknown_thing:", resolve))
      .toBe("ship it 🚀 👍 :unknown_thing:");
  });
  test("a time like 10:30: is not an emoji", () => {
    expect(replaceShortcodes("at 10:30:45 sharp")).toBe("at 10:30:45 sharp");
  });
});

describe("emoji", () => {
  test("round trips the common reactions", () => {
    for (const name of ["+1", "heart", "eyes", "white_check_mark", "tada", "rocket", "fire", "joy", "pray"]) {
      const glyph = shortcodeToEmoji(name)!;
      expect(glyph).toBeTruthy();
      expect(emojiToShortcode(glyph)).toBe(name);
    }
  });
  test("thumbsup aliases to +1 and tones are stripped", () => {
    expect(shortcodeToEmoji(":thumbsup:")).toBe("👍");
    expect(emojiToShortcode("👍🏽")).toBe("+1");
    expect(emojiToShortcode("❤")).toBe("heart");
    expect(emojiToShortcode("🫥")).toBeNull();
  });
});

describe("attachments", () => {
  test("a bot card becomes a quote block", () => {
    const md = slackAttachmentsToMarkdown(
      [{ author_name: "GitHub", title: "PR #12", title_link: "https://g.h/12", text: "Fixes *the* thing", footer: "repo" }],
      resolve,
    );
    expect(md).toBe("> *GitHub* · **[PR #12](https://g.h/12)**\n>\n> Fixes **the** thing\n>\n> *repo*");
  });
  test("empty input", () => {
    expect(slackAttachmentsToMarkdown(undefined, resolve)).toBe("");
    expect(slackAttachmentsToMarkdown([{}], resolve)).toBe("");
  });
});

const out = {
  handleToSlackUser: (h: string) => (h === "ashot" ? "U1" : null),
  entityUrl: (id: string) => (id === "ct-12" ? "https://codecast.sh/tasks/ct-12" : null),
};

describe("markdownToSlack", () => {
  test("emphasis, headers, strike, bullets", () => {
    expect(markdownToSlack("# Title\n**bold** *it* ~~gone~~\n- a\n- b", out))
      .toBe("*Title*\n*bold* _it_ ~gone~\n• a\n• b");
  });
  test("links, images, entities", () => {
    expect(markdownToSlack("[docs](https://a.b/x?q=1&r=2) ![shot](https://a.b/i.png) a < b & c", out))
      .toBe("<https://a.b/x?q=1&amp;r=2|docs> <https://a.b/i.png|shot> a &lt; b &amp; c");
  });
  test("mentions: mapped handle pages, unmapped stays text, here broadcasts", () => {
    expect(markdownToSlack("@ashot @nobody @here", out)).toBe("<@U1> @nobody <!here>");
  });
  test("entity ids become links", () => {
    expect(markdownToSlack("see ct-12 and ct-99", out)).toBe("see <https://codecast.sh/tasks/ct-12|ct-12> and ct-99");
  });
  test("code is protected and escaped", () => {
    expect(markdownToSlack("run `a && b` then\n```\n**not bold** <x>\n```", out))
      .toBe("run `a &amp;&amp; b` then\n```\n**not bold** &lt;x&gt;\n```");
  });
  test("a sentence survives the round trip", () => {
    const slack = "*Deploy* is _done_ — see <https://a.b|the run> :tada: <@U1>";
    const md = slackToMarkdown(slack, resolve);
    expect(md).toBe("**Deploy** is *done* — see [the run](https://a.b) 🎉 @ashot");
    expect(markdownToSlack(md, out)).toBe("*Deploy* is _done_ — see <https://a.b|the run> 🎉 <@U1>");
  });
});

describe("slackDisplayName", () => {
  test("marks agents", () => {
    expect(slackDisplayName({ name: "Ashot" })).toBe("Ashot");
    expect(slackDisplayName({ name: "Anchor", isAgent: true })).toBe("Anchor (agent)");
    expect(slackDisplayName({ name: "Fix auth", isAgent: true, via: "Ashot" })).toBe("Fix auth (agent · via Ashot)");
  });
});

test("decodeSlackEntities", () => {
  expect(decodeSlackEntities("&lt;a&gt; &amp; b")).toBe("<a> & b");
});

test("an entity id inside a link label is not linked twice", () => {
  expect(markdownToSlack("[ct-12](https://x.y/z) and ct-12", out)).toBe("<https://x.y/z|ct-12> and <https://codecast.sh/tasks/ct-12|ct-12>");
});
