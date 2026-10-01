import assert from "node:assert/strict";
import { mock, test } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";
import { realInboxStore, restoreInboxStoreAfterAll } from "../__tests__/mockInboxStore";

restoreInboxStoreAfterAll();

const CH = "hx7y44z7mkmwjw7fhy0j4tqvz58egdrj";
const MSG = "jd7aaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// The shapes slackText's sharedMessageMarkdown writes for a quoted Slack line.
const internal = `Look at this\n\n> [Riley Baskali](/chat/${CH}?m=${MSG})\n>\n> You got a clear **yes** on Carlos`;
const slackOnly = "> [Riley Baskali](https://union-app.slack.com/archives/C0AEEDANANR/p1790893978215669)\n>\n> Only in Slack";
const plain = "> just a quote";

test("a quoted message renders as a card that opens the original in place", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://local.codecast.sh/chat/dm" });
  const restore = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
  const ensured: Array<string | undefined> = [];
  const row = {
    _id: MSG,
    channel_id: CH,
    user_id: "bridge",
    content: "x",
    created_at: Date.UTC(2026, 9, 1, 17, 32),
    external_author: { name: "Riley Baskali", avatar_url: "https://a/riley.jpg" },
  };
  mock.module("../../hooks/useChatSync", () => ({
    useEnsureChatMessage: (id?: string) => ensured.push(id),
    useChatMessageRow: (id?: string) => (id === MSG ? row : undefined),
    useChatMembers: () => ({ byId: new Map() }),
  }));
  mock.module("../../store/inboxStore", () => ({
    ...realInboxStore,
    useInboxStore: (sel: any) => sel({ chatChannels: { [CH]: { name: "union-ops" } } }),
  }));
  mock.module("next/link", () => ({ default: ({ href, children, ...rest }: any) => <a href={href} data-internal {...rest}>{children}</a> }));
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const ReactMarkdown = (await import("react-markdown")).default;
  const { ChatBlockquote } = await import("./ChatQuote");
  const root = createRoot(document.getElementById("root")!);
  const render = (md: string) =>
    React.act(async () => root.render(<ReactMarkdown components={{ blockquote: ChatBlockquote }}>{md}</ReactMarkdown>));
  try {
    await render(internal);
    const card = document.querySelector(".ch-quote")!;
    assert.ok(card, "card rendered");
    const head = card.querySelector<HTMLAnchorElement>(".ch-quote-head")!;
    assert.equal(head.getAttribute("href"), `/chat/${CH}?m=${MSG}`);
    assert.ok(head.hasAttribute("data-internal"), "opens in app");
    assert.equal(card.querySelector(".ch-quote-author")!.textContent, "Riley Baskali");
    assert.match(card.textContent!, /#union-ops/);
    assert.equal(card.querySelector(".ch-quote-body")!.textContent!.trim(), "You got a clear yes on Carlos");
    assert.equal(card.querySelectorAll("p").length, 1, "header paragraph drawn by the card, not repeated");
    assert.deepEqual(ensured.filter(Boolean), [MSG]);

    await render(slackOnly);
    const ext = document.querySelector<HTMLAnchorElement>(".ch-quote .ch-quote-head")!;
    assert.equal(ext.getAttribute("target"), "_blank");
    assert.match(ext.textContent!, /Riley Baskali/);

    await render(plain);
    assert.equal(document.querySelector(".ch-quote"), null);
    assert.equal(document.querySelector("blockquote")!.textContent!.trim(), "just a quote");
  } finally {
    await React.act(async () => root.unmount());
    restore();
  }
}, 120_000);
