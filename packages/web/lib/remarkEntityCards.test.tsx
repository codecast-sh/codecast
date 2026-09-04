import { test, expect, describe, mock } from "bun:test";

// The whole path runs for real — markdown → remark plugins → components —
// with only the Convex transport faked, exactly like the references suite.

const TASK_CONVEX_ID = "kx82qtvpbmmrmwcjqmhzawejsx8bq9gm";
const FAKE_TASK = {
  _id: TASK_CONVEX_ID,
  short_id: "ct-46943",
  title: "Rich object preview cards in chat: preserve the full title when shared with surrounding text",
  description: "Preview-tier rendering for shared object references, with inline expansion.",
  status: "in_progress",
  priority: "high",
  comments: [
    { _id: "c0", author: "Ashot", text: "An earlier note", created_at: Date.now() - 7200_000, comment_type: "note" },
    { _id: "c1", author: "Ashot", text: "Looks great so far", created_at: Date.now() - 3600_000, comment_type: "note" },
  ],
  plan: { short_id: "pl-476", title: "Rich inline object embeds", status: "active" },
  updated_at: Date.now() - 120_000,
};

const PLAN_CONVEX_ID = "mx82qtvpbmmrmwcjqmhzawejsx8bq9gm";
const FAKE_PLAN = {
  _id: PLAN_CONVEX_ID,
  short_id: "pl-476",
  title: "Rich inline object embeds",
  status: "active",
  goal: "Shared objects render as browsable preview cards.",
  tasks: [
    { _id: "t1", title: "Detection plugin", status: "done" },
    { _id: "t2", title: "Card component", status: "in_progress" },
  ],
  updated_at: Date.now() - 60_000,
};

const SESSION_CONVEX_ID = "jx84qtvpbmmrmwcjqmhzawejsx8bq9gm";
const FAKE_SESSION = {
  _id: SESSION_CONVEX_ID,
  short_id: "jx84qtv",
  title: "Build the card system",
  status: "active",
  agent_type: "claude",
  message_count: 42,
  subtitle: "Goal: cards for shared objects",
  last_message_preview: "Wired the plugin into chat.",
  last_message_role: "assistant",
  project_path: "/Users/ashot/src/codecast",
  updated_at: Date.now() - 30_000,
};

const DOC_CONVEX_ID = "dx82qtvpbmmrmwcjqmhzawejsx8bq9gm";
const FAKE_DOC = {
  _id: DOC_CONVEX_ID,
  display_title: "Card design notes",
  title: "Card design notes",
  doc_type: "note",
  content: "# Card design notes\n\nAccent per type, grid rows, expand inline.",
  updated_at: Date.now() - 500_000,
};

const PROJECT_CONVEX_ID = "sx82qtvpbmmrmwcjqmhzawejsx8bq9gm";
const FAKE_PROJECT = { _id: PROJECT_CONVEX_ID, name: "Product improvements", description: "Larger inline objects throughout chat." };
const FAKE_TRIGGER = { _id: "tx82qtvpbmmrmwcjqmhzawejsx8bq9gm", short_id: "tr-476", display_title: "Check the release", status: "active", prompt: "Read the release checks and report any failures.", trigger_type: "manual" };

const MSG_CONVEX_ID = "kx91qtvpbmmrmwcjqmhzawejsx8bq9gm";
const SHARE_TOKEN = "3f0c1b2a-7d4e-4c9a-9b1e-2a6f8c0d1e2f";
const FAKE_MESSAGE = {
  _id: MSG_CONVEX_ID,
  conversation_id: SESSION_CONVEX_ID,
  role: "assistant",
  content: "Shipped the **card plugin**.\n\n- detection\n- rendering",
  timestamp: Date.now() - 900_000,
};
const FAKE_SHARED_MESSAGE = {
  message: FAKE_MESSAGE,
  contextMessages: [FAKE_MESSAGE],
  conversation: { _id: SESSION_CONVEX_ID, title: FAKE_SESSION.title, agent_type: "claude_code" },
  conversationShareToken: null,
  user: { name: "Ashot", image: null },
  note: null,
  sharedAt: Date.now() - 60_000,
};

const { getFunctionName } = await import("convex/server");

const ROWS: Record<string, any[]> = {
  "tasks:webGet": [FAKE_TASK],
  "plans:webGet": [FAKE_PLAN],
  "conversations:webGet": [FAKE_SESSION],
  "agentTasks:webGet": [FAKE_TRIGGER],
  "projects:webGet": [FAKE_PROJECT],
};

function fakeQuery(fn: unknown, args: any) {
  if (args === "skip") return undefined;
  const name = getFunctionName(fn as any);
  if (name === "entities:resolveIdType") return args?.id === DOC_CONVEX_ID ? "doc" : args?.id === PROJECT_CONVEX_ID ? "project" : null;
  if (name === "docs:webGet") return args?.id === DOC_CONVEX_ID ? FAKE_DOC : null;
  if (name === "messages:getSharedMessage") return args?.share_token === SHARE_TOKEN ? FAKE_SHARED_MESSAGE : null;
  if (name === "messages:webGet") return args?.id === MSG_CONVEX_ID ? FAKE_SHARED_MESSAGE : null;
  const rows = ROWS[name];
  if (!rows) return undefined;
  return rows.find((r) => r.short_id === args?.short_id || r._id === args?.id) ?? null;
}

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: fakeQuery,
  useQueries: () => ({}),
}));

const noThrow = await import("../hooks/useQueryNoThrow");
mock.module("../hooks/useQueryNoThrow", () => ({
  ...noThrow,
  useQueryNoThrow: (fn: unknown, args: any) => ({ data: fakeQuery(fn, args) }),
}));

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router");
const { default: ReactMarkdown } = await import("react-markdown");
const { default: remarkBreaks } = await import("remark-breaks");
const { entityRemarkPlugins } = await import("./remarkEntityIds");
const { remarkEntityCards } = await import("./remarkEntityCards");
const { EntityAwareLink, EntityAwareCode } = await import("../components/EntityIdPill");

const MD_COMPONENTS = { a: EntityAwareLink, code: EntityAwareCode } as const;
// Chat's shape: entity ids, single newlines as hard breaks, then the card
// promotion pass — the same order ChatMessage registers.
const PLUGINS = [...entityRemarkPlugins, remarkBreaks, remarkEntityCards] as any[];

function render(markdown: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ReactMarkdown remarkPlugins={PLUGINS} components={MD_COMPONENTS as any}>
        {markdown}
      </ReactMarkdown>
    </MemoryRouter>,
  );
}

describe("shared-object detection", () => {
  test("an id alone on its line becomes a full preview card, not a pill", () => {
    const html = render("ct-46943");
    expect(html).toContain("entity-card-row");
    expect(html).toContain('data-card-count="1"');
    // The card previews usably before any click: title, status, snippet.
    expect(html).toContain("Rich object preview cards in chat");
    expect(html).toContain("Preview-tier rendering for shared object references");
    // And it is a real card, not the inline pill chrome.
    expect(html).not.toContain("not-prose inline-flex");
  });

  test("an id inside a sentence becomes a card between intact prose blocks", () => {
    const html = render("Picked up ct-46943 this morning.");
    expect(html).toContain("entity-card-row");
    expect(html).toContain("<p>Picked up </p>");
    expect(html).toContain("<p> this morning.</p>");
    expect(html).toContain("Rich object preview cards in chat");
  });

  test("prose paragraph plus a shared id paragraph: prose stays, card renders", () => {
    const html = render("Here is the task:\n\nct-46943\n\nThoughts?");
    expect(html).toContain("Here is the task:");
    expect(html).toContain("Thoughts?");
    expect(html).toContain("entity-card-row");
    expect(html).toContain('data-card-count="1"');
  });

  test("the screenshot shape promotes adjacent mentions followed by prose", () => {
    const html = render("I'm confused on this one — why is it asking me?\n@[First task ct-46943]\n@[Related plan pl-476] and what about this one?");
    expect(html).toContain('data-card-count="2"');
    expect(html).toContain("why is it asking me?");
    expect(html).toContain("and what about this one?");
    expect(html).not.toMatch(/<p>\s*<div/);
  });

  test("emphasized references are lifted out without losing surrounding formatting", () => {
    const html = render("Review **the task ct-46943 today** please.");
    expect(html).toContain("<strong>the task </strong>");
    expect(html).toContain("<strong> today</strong>");
    expect(html).toContain("entity-card-row");
    expect(html).not.toMatch(/<strong>\s*<div/);
  });

  test("object URLs get the same cards as short references", () => {
    const html = render("Review https://codecast.sh/tasks/ct-46943 and [the plan](/plans/pl-476).");
    expect(html.match(/entity-card-row/g)?.length).toBe(2);
    expect(html).toContain("Rich object preview cards in chat");
    expect(html).toContain("Rich inline object embeds");
  });

  test("code and date references remain inline", () => {
    const html = render("Run `cast task show ct-46943` @[tomorrow date:2026-08-30].");
    expect(html).not.toContain("entity-card-row");
    expect(html).toContain("cast task show ct-46943");
  });

  test("several ids on adjacent lines share one card row", () => {
    const html = render("ct-46943\npl-476");
    const rows = html.match(/entity-card-row/g) ?? [];
    expect(rows.length).toBe(1);
    expect(html).toContain('data-card-count="2"');
    expect(html).toContain("Rich object preview cards in chat");
    expect(html).toContain("Rich inline object embeds");
  });

  test("a bullet list of ids becomes one card row", () => {
    const html = render("- ct-46943\n- pl-476\n- jx84qtv");
    expect(html).toContain('data-card-count="3"');
    expect(html).not.toContain("<li");
    expect(html).toContain("Build the card system");
  });

  test("a list with prose items keeps its list structure and expands references", () => {
    const html = render("- ct-46943 needs review\n- pl-476");
    expect(html).toContain("entity-card-row");
    expect(html).toContain("<li");
    expect(html).toContain("needs review");
  });

  test("a date reference alone never becomes a card", () => {
    const html = render("@[tomorrow date:2026-08-30]");
    expect(html).not.toContain("entity-card-row");
  });

  test("an unresolvable id degrades to plain text, not a broken card", () => {
    const html = render("ct-99999");
    expect(html).toContain("ct-99999");
    expect(html).not.toContain("Loading");
  });

  test("a quoted share renders the card inside the blockquote", () => {
    // Quoting someone's share re-shares it — the card carries into the quote
    // (a div inside a blockquote is valid flow content).
    const html = render("> ct-46943");
    expect(html).toContain("<blockquote");
    expect(html).toContain("entity-card-row");
  });

  test("a hand-typed card payload cannot smuggle a card onto other surfaces", () => {
    // EntityAwareLink is shared by every markdown surface; only links this
    // plugin rewrote (marker class) may render cards. A `[card:1:…](url)`
    // typed into a doc or task description renders through pipelines WITHOUT
    // remarkEntityCards — it must stay an ordinary link, never a block card
    // inside a <p>.
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ReactMarkdown remarkPlugins={entityRemarkPlugins as any[]} components={MD_COMPONENTS as any}>
          {"See [card:1:ct-46943](https://example.com) for details."}
        </ReactMarkdown>
      </MemoryRouter>,
    );
    expect(html).not.toContain("entity-card");
    expect(html).toContain("card:1:ct-46943");
  });
});

describe("card previews per type", () => {
  test("collapsed cards keep the complete title", () => {
    expect(render("ct-46943")).toContain(FAKE_TASK.title);
  });

  test("all six object types become cards when mentioned together in prose", () => {
    const html = render(`Review ct-46943 pl-476 jx84qtv doc:${DOC_CONVEX_ID} tr-476 ${PROJECT_CONVEX_ID} today.`);
    expect(html).toContain('data-card-count="6"');
    expect(html).toContain("Check the release");
    expect(html).toContain("Product improvements");
  });
  test("a session card is the inbox card: title, summary, user line, project footer", () => {
    const html = render("jx84qtv");
    expect(html).toContain("Build the card system");
    expect(html).toContain("Goal:");
    // The blue `>` last-user-message line, straight from the inbox card.
    expect(html).toContain("Wired the plugin into chat.");
    // Project chip derived from project_path, colored like inbox labels.
    expect(html).toContain("codecast");
    // Flat inbox look — no accent header strip on session cards.
    expect(html).not.toContain("bg-sol-blue/10 dark:bg-sol-blue");
  });

  test("a plan card shows goal and progress", () => {
    const html = render("pl-476");
    expect(html).toContain("Shared objects render as browsable preview cards.");
    expect(html).toContain("1/2");
  });

  test("a doc card shows a real content preview", () => {
    const html = render(`doc:${DOC_CONVEX_ID}`);
    expect(html).toContain("Card design notes");
    expect(html).toContain("Accent per type, grid rows, expand inline.");
  });

  test("a collapsed task shows its LATEST comment; older ones wait for expand", () => {
    const html = render("ct-46943");
    expect(html).toContain("Looks great so far");
    expect(html).not.toContain("An earlier note");
  });
});

describe("shared conversation messages", () => {
  const shareUrl = `https://codecast.sh/share/message/${SHARE_TOKEN}`;
  const inPlaceUrl = `https://codecast.sh/conversation/${SESSION_CONVEX_ID}#msg-${MSG_CONVEX_ID}`;

  test("a share link alone on its line is a card that renders the message rich", () => {
    const html = render(shareUrl);
    expect(html).toContain("entity-card-row");
    expect(html).toContain('data-card-count="1"');
    // The session it came from, who wrote it, and the message body as markdown.
    expect(html).toContain("Build the card system");
    expect(html).toContain("Claude");
    expect(html).toContain("card plugin</strong>");
    expect(html).toContain("<li");
    // Not the raw link.
    expect(html).not.toContain(`>${shareUrl}<`);
  });

  test("a message deep link into the conversation is the same card", () => {
    const html = render(inPlaceUrl);
    expect(html).toContain("entity-card-row");
    expect(html).toContain("card plugin</strong>");
    expect(html).toContain(`href="/conversation/${SESSION_CONVEX_ID}#msg-${MSG_CONVEX_ID}"`);
  });

  test("a note above the link (its own paragraph, as forwardToChat sends it) keeps the note as prose and the card below it", () => {
    const html = render(`Look at this one\n\n${shareUrl}`);
    expect(html).toContain("Look at this one");
    expect(html).toContain("entity-card-row");
  });

  test("a share link inside a sentence becomes a card with the surrounding prose", () => {
    const html = render(`As I said in ${shareUrl} yesterday.`);
    expect(html).toContain("entity-card-row");
    expect(html).toContain("<p>As I said in </p>");
    expect(html).toContain("<p> yesterday.</p>");
    expect(html).toContain("card plugin</strong>");
  });

  test("a link the author gave their own words keeps them", () => {
    const html = render(`[the fix](${shareUrl})`);
    expect(html).not.toContain("entity-card-row");
    expect(html).toContain("the fix");
  });

  test("an unknown token is not available, not a broken card", () => {
    const html = render("https://codecast.sh/share/message/no-such-token-here");
    expect(html).toContain("Not available to you.");
  });
});
