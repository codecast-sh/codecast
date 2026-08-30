import { test, expect, describe, mock } from "bun:test";

// End-to-end check of shared-object cards: a chat line that is NOTHING BUT
// object references renders each as a rich preview card (remarkEntityCards →
// EntityObjectCard), while a reference inside prose stays an inline pill.
// The whole path runs for real — markdown → remark plugins → components —
// with only the Convex transport faked, exactly like the references suite.

const TASK_CONVEX_ID = "kx82qtvpbmmrmwcjqmhzawejsx8bq9gm";
const FAKE_TASK = {
  _id: TASK_CONVEX_ID,
  short_id: "ct-46943",
  title: "Rich object preview cards in chat",
  description: "Preview-tier rendering for shared object references, with inline expansion.",
  status: "in_progress",
  priority: "high",
  comments: [
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

const { getFunctionName } = await import("convex/server");

const ROWS: Record<string, any[]> = {
  "tasks:webGet": [FAKE_TASK],
  "plans:webGet": [FAKE_PLAN],
  "conversations:webGet": [FAKE_SESSION],
};

function fakeQuery(fn: unknown, args: any) {
  if (args === "skip") return undefined;
  const name = getFunctionName(fn as any);
  if (name === "entities:resolveIdType") return args?.id === DOC_CONVEX_ID ? "doc" : null;
  if (name === "docs:webGet") return args?.id === DOC_CONVEX_ID ? FAKE_DOC : null;
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

  test("an id inside a sentence stays an inline pill", () => {
    const html = render("Picked up ct-46943 this morning.");
    expect(html).not.toContain("entity-card-row");
    expect(html).toContain("not-prose inline-flex");
    expect(html).toContain("Rich object preview cards in chat");
  });

  test("prose paragraph plus a shared id paragraph: prose stays, card renders", () => {
    const html = render("Here is the task:\n\nct-46943\n\nThoughts?");
    expect(html).toContain("Here is the task:");
    expect(html).toContain("Thoughts?");
    expect(html).toContain("entity-card-row");
    expect(html).toContain('data-card-count="1"');
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

  test("a list with prose items stays a list of pills", () => {
    const html = render("- ct-46943 needs review\n- pl-476");
    expect(html).not.toContain("entity-card-row");
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
  test("a session card shows state, summary and last message", () => {
    const html = render("jx84qtv");
    expect(html).toContain("Build the card system");
    expect(html).toContain("Active");
    expect(html).toContain("Goal:");
    expect(html).toContain("Wired the plugin into chat.");
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

  test("expanded-only detail (task comments) stays out of the collapsed card", () => {
    const html = render("ct-46943");
    expect(html).not.toContain("Looks great so far");
  });
});
