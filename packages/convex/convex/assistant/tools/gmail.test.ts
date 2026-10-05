// The Gmail tools against a fake Google (plan pl-840): the requests they make,
// the shapes they read back, the messages they build, and that the token never
// leaves the Authorization header.
import { describe, expect, test } from "bun:test";
import { runTool, type Tool } from "@platform/agent";
import { decodeBase64, encodeBase64 } from "@codecast/shared/encryption";
import type { GoogleTokenResult } from "../../googleOAuth";
import { GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from "../../googleOAuth";
import { sharedTokens, type GoogleDeps } from "./google";
import { bareAddress, buildRawMessage, deliveredAddress, gmailTools, messageText, replyEnvelope, SEARCH_READS_IN_FLIGHT, THREAD_MAX_CHARS } from "./gmail";

const TOKEN = "ya29.secret-access-token";
const b64 = (text: string) => encodeBase64(new TextEncoder().encode(text), "base64url");
const unraw = (raw: string) => new TextDecoder().decode(decodeBase64(raw, "base64url"));
/** The decoded body of a raw message built by buildRawMessage. */
const bodyOf = (raw: string) => new TextDecoder().decode(decodeBase64(unraw(raw).split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64"));

type Call = { method: string; url: URL; body?: any; auth: string | null };

/** A fake Google: routes by method and path, records every call. */
function fakeGoogle(routes: Record<string, (call: Call) => unknown>, opts: { granted?: string[]; failFirst401?: boolean } = {}) {
  const calls: Call[] = [];
  const tokenAsks: { scope: string; force?: boolean }[] = [];
  let first401 = opts.failFirst401 ?? false;
  const deps: GoogleDeps = {
    token: async (scope, o) => {
      tokenAsks.push({ scope, ...(o?.force ? { force: true } : {}) });
      const granted = opts.granted ?? [GMAIL_MODIFY_SCOPE];
      const covered = granted.includes(scope) || (granted.includes(GMAIL_MODIFY_SCOPE) && (scope === GMAIL_READONLY_SCOPE || scope === GMAIL_SEND_SCOPE));
      if (!covered) return { ok: false, code: "missing_scope", error: "no", grant: "gmail.modify" } as GoogleTokenResult;
      return { ok: true, access_token: TOKEN, email: "me@example.com", installation_id: "inst" };
    },
    fetch: (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const call: Call = {
        method: init.method ?? "GET",
        url,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        auth: new Headers(init.headers).get("Authorization"),
      };
      calls.push(call);
      if (first401) {
        first401 = false;
        return new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 });
      }
      const key = `${call.method} ${url.pathname.replace("/gmail/v1/users/me", "")}`;
      const route = Object.entries(routes).find(([pattern]) => new RegExp(`^${pattern}$`).test(key));
      if (!route) return new Response(JSON.stringify({ error: { message: `no route ${key}` } }), { status: 404 });
      return new Response(JSON.stringify(route[1](call) ?? {}), { status: 200 });
    }) as typeof fetch,
  };
  return { deps, calls, tokenAsks };
}

const tool = (deps: GoogleDeps, name: string, can = { read_mail: true, modify_mail: true, send_mail: true }): Tool =>
  gmailTools(deps, can).find((t) => t.name === name)!;

const run = async (t: Tool, args: unknown) => {
  const result = await runTool(t, args, { callId: "toolu_1" });
  return { text: result.content.map((c) => (c.type === "text" ? c.text : "")).join(""), details: result.details as any };
};

const metaThread = (id: string, from: string, subject: string, unread = false) => ({
  id,
  messages: [{ id: `${id}-m`, threadId: id, internalDate: "1759600000000", labelIds: unread ? ["UNREAD", "INBOX"] : ["INBOX"], snippet: `snippet of ${id}`, payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }] } }],
});

describe("search_mail", () => {
  test("lists threads with sender, subject and snippet, fenced as mail", async () => {
    const g = fakeGoogle({
      "GET /threads": () => ({ threads: [{ id: "t1" }, { id: "t2" }] }),
      "GET /threads/t1": () => metaThread("t1", "Dana <dana@x.com>", "Lunch?", true),
      "GET /threads/t2": () => metaThread("t2", "bank@y.com", "Statement"),
    });
    const { text, details } = await run(tool(g.deps, "search_mail"), { query: "newer_than:7d", max: 5 });
    expect(g.calls[0].url.searchParams.get("q")).toBe("newer_than:7d");
    expect(g.calls[0].url.searchParams.get("maxResults")).toBe("5");
    expect(g.calls[1].url.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "Date"]);
    expect(text).toContain("<untrusted-");
    expect(text).toContain("Thread t1");
    expect(text).toContain("unread");
    expect(text).toContain("From: Dana <dana@x.com>");
    expect(text).toContain("Subject: Statement");
    expect(details).toEqual({ threads: 2 });
    expect(g.tokenAsks.every((a) => a.scope === GMAIL_READONLY_SCOPE)).toBe(true);
  });

  test("a stale token is refreshed once and the call retried", async () => {
    const g = fakeGoogle({ "GET /threads": () => ({}) }, { failFirst401: true });
    const { text } = await run(tool(g.deps, "search_mail"), { query: "x" });
    expect(text).toContain("No threads match");
    expect(g.tokenAsks).toEqual([{ scope: GMAIL_READONLY_SCOPE }, { scope: GMAIL_READONLY_SCOPE, force: true }]);
  });

  test("shared tokens: a search reading many threads asks for the token once, and one refusal refreshes once", async () => {
    const ids = ["t1", "t2", "t3", "t4"];
    const routes = {
      "GET /threads": () => ({ threads: ids.map((id) => ({ id })) }),
      ...Object.fromEntries(ids.map((id) => [`GET /threads/${id}`, () => metaThread(id, "a@b.co", id)])),
    };
    const g = fakeGoogle(routes);
    await run(tool(sharedTokens(g.deps), "search_mail"), { query: "x" });
    expect(g.tokenAsks).toEqual([{ scope: GMAIL_READONLY_SCOPE }]);

    // Every call is refused once with the old token: one forced refresh serves them all.
    let fresh = false;
    const refused = fakeGoogle(routes);
    const inner = refused.deps;
    const shared = sharedTokens({
      ...inner,
      token: async (scope, o) => {
        refused.tokenAsks.push({ scope, ...(o?.force ? { force: true } : {}) });
        if (o?.force) fresh = true;
        return { ok: true, access_token: fresh ? "fresh" : "old", email: "me@example.com", installation_id: "inst" };
      },
      fetch: (async (input: string, init: RequestInit = {}) =>
        new Headers(init.headers).get("Authorization") === "Bearer old"
          ? new Response("{}", { status: 401 })
          : inner.fetch!(input, init)) as typeof fetch,
    });
    const { details } = await run(tool(shared, "search_mail"), { query: "x" });
    expect(details).toMatchObject({ threads: 4 });
    expect(refused.tokenAsks).toEqual([{ scope: GMAIL_READONLY_SCOPE }, { scope: GMAIL_READONLY_SCOPE, force: true }]);
  });

  test("a thread that cannot be read is skipped and counted; reads stay a few at a time", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    let inFlight = 0;
    let most = 0;
    const g = fakeGoogle({
      "GET /threads": () => ({ threads: ids.map((id) => ({ id })) }),
      // t3 was deleted between the list and the read: no route, so a 404.
      ...Object.fromEntries(ids.filter((id) => id !== "t3").map((id) => [`GET /threads/${id}`, () => metaThread(id, "a@b.co", `Subject ${id}`)])),
    });
    const inner = g.deps.fetch!;
    g.deps.fetch = (async (input: string, init?: RequestInit) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await inner(input, init);
      } finally {
        inFlight--;
      }
    }) as typeof fetch;
    const { text, details } = await run(tool(g.deps, "search_mail"), { query: "x", max: 12 });
    expect(details).toEqual({ threads: 11, skipped: 1 });
    expect(text).toContain("Subject t11");
    expect(text).not.toContain("Thread t3 ");
    expect(text).toContain("[1 more thread matched but could not be read]");
    expect(most).toBeLessThanOrEqual(SEARCH_READS_IN_FLIGHT + 1);
  });

  test("when every thread read fails, the search fails", async () => {
    const g = fakeGoogle({ "GET /threads": () => ({ threads: [{ id: "gone1" }, { id: "gone2" }] }) });
    await expect(runTool(tool(g.deps, "search_mail"), { query: "x" }, { callId: "c" })).rejects.toThrow();
  });

  test("an unsent draft never speaks for a thread: the latest sent message does, and the draft is counted", async () => {
    const g = fakeGoogle({
      "GET /threads": () => ({ threads: [{ id: "t1" }, { id: "t2" }] }),
      "GET /threads/t1": () => ({
        id: "t1",
        messages: [
          { id: "m1", threadId: "t1", internalDate: "1759600000000", labelIds: ["INBOX"], snippet: "Can you pay invoice 42?", payload: { headers: [{ name: "From", value: "dana@x.com" }, { name: "Subject", value: "Invoice" }] } },
          { id: "m2", threadId: "t1", internalDate: "1759600100000", labelIds: ["DRAFT"], snippet: "Paid it already", payload: { headers: [{ name: "From", value: "me@example.com" }] } },
        ],
      }),
      "GET /threads/t2": () => ({
        id: "t2",
        messages: [{ id: "m3", threadId: "t2", internalDate: "1759600000000", labelIds: ["DRAFT"], snippet: "Dear landlord", payload: { headers: [{ name: "From", value: "me@example.com" }, { name: "Subject", value: "Lease" }] } }],
      }),
    });
    const { text } = await run(tool(g.deps, "search_mail"), { query: "x" });
    const [one, two] = text.split("\n\nThread ");
    expect(one).toContain("2 messages · 1 unsent draft");
    expect(one).toContain("From: dana@x.com");
    expect(one).toContain("Snippet: Can you pay invoice 42?");
    expect(one).not.toContain("Paid it already");
    expect(one).not.toContain("Draft (not sent)");
    expect(two).toContain("Draft (not sent)\nFrom: me@example.com");
  });

  test("the token only ever rides in the Authorization header", async () => {
    const g = fakeGoogle({ "GET /threads": () => ({ threads: [{ id: "t1" }] }), "GET /threads/t1": () => metaThread("t1", "a@b.c", "Hi") });
    const out = await run(tool(g.deps, "search_mail"), { query: "x" });
    expect(g.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(g.calls.some((c) => c.url.href.includes(TOKEN))).toBe(false);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});

describe("read_thread", () => {
  test("reads the plain part, falls back to HTML as text, and names attachments", async () => {
    const g = fakeGoogle({
      "GET /threads/t9": () => ({
        id: "t9",
        messages: [
          {
            id: "m1",
            threadId: "t9",
            payload: {
              mimeType: "multipart/mixed",
              headers: [{ name: "From", value: "Dana <dana@x.com>" }, { name: "To", value: "me@example.com" }, { name: "Subject", value: "Plans" }, { name: "Date", value: "Sat, 4 Oct 2026 10:00:00 -0700" }],
              parts: [
                { mimeType: "multipart/alternative", parts: [
                  { mimeType: "text/plain", body: { data: b64("Are you free Tuesday?\r\nDana") } },
                  { mimeType: "text/html", body: { data: b64("<p>Are you free <b>Tuesday</b>?</p>") } },
                ] },
                { mimeType: "application/pdf", filename: "menu.pdf", body: { attachmentId: "a1" } },
              ],
            },
          },
          {
            id: "m2",
            threadId: "t9",
            payload: { mimeType: "text/html", headers: [{ name: "From", value: "me@example.com" }], body: { data: b64("<div>Yes, <i>after 2</i>.</div><script>x()</script>") } },
          },
        ],
      }),
    });
    const { text, details } = await run(tool(g.deps, "read_thread"), { thread_id: "t9" });
    expect(g.calls[0].url.searchParams.get("format")).toBe("full");
    expect(text).toContain("Are you free Tuesday?\nDana");
    expect(text).toContain("Attachments: menu.pdf");
    expect(text).toContain("Yes, after 2 .");
    expect(text).not.toContain("x()");
    expect(details).toEqual({ messages: 2 });
  });

  test("a draft in the thread is marked as not sent", async () => {
    const g = fakeGoogle({
      "GET /threads/t7": () => ({
        id: "t7",
        messages: [
          { id: "m1", threadId: "t7", labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: "dana@x.com" }], body: { data: b64("Lunch?") } } },
          { id: "m2", threadId: "t7", labelIds: ["DRAFT"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: "me@example.com" }], body: { data: b64("Yes, noon.") } } },
        ],
      }),
    });
    const { text } = await run(tool(g.deps, "read_thread"), { thread_id: "t7" });
    const [first, second] = text.split("\n---\n");
    expect(first).not.toContain("Draft (not sent)");
    expect(second).toContain("Draft (not sent)\nFrom: me@example.com");
  });

  test("a long thread keeps its newest messages whole and shortens the older ones", async () => {
    const n = 60;
    const g = fakeGoogle({
      "GET /threads/long": () => ({
        id: "long",
        messages: Array.from({ length: n }, (_, i) => ({
          id: `m${i}`, threadId: "long", labelIds: ["INBOX"], snippet: `snippet ${i}`,
          payload: { mimeType: "text/plain", headers: [{ name: "From", value: `p${i}@x.com` }], body: { data: b64(`body ${i} `.repeat(2_000)) } },
        })),
      }),
    });
    const { text, details } = await run(tool(g.deps, "read_thread"), { thread_id: "long" });
    // The fence never had to cut: the newest message is there whole, at the end.
    expect(text).not.toContain("[truncated]");
    expect(text).toContain(`body ${n - 1} body`);
    expect(text).toContain("[cut: the message goes on]\n</untrusted-");
    expect(details.messages).toBe(n);
    expect(details.shortened).toBeGreaterThan(40);
    expect(text).toContain(`[${details.shortened} earlier messages shortened to sender, date and snippet]`);
    expect(text).toContain("Snippet: snippet 0");
    expect(text).not.toContain("body 0 body");
    expect(details.omitted).toBeUndefined();
    expect(text.length).toBeLessThanOrEqual(THREAD_MAX_CHARS + 500);
  });

  test("a thread too long even for snippets leaves its earliest messages out, and says so", async () => {
    const n = 600;
    const g = fakeGoogle({
      "GET /threads/huge": () => ({
        id: "huge",
        messages: Array.from({ length: n }, (_, i) => ({
          id: `m${i}`, threadId: "huge", labelIds: ["INBOX"], snippet: `snippet ${i} `.repeat(10),
          payload: { mimeType: "text/plain", headers: [{ name: "From", value: `p${i}@x.com` }], body: { data: b64(`body ${i}`) } },
        })),
      }),
    });
    const { text, details } = await run(tool(g.deps, "read_thread"), { thread_id: "huge" });
    expect(text).not.toContain("[truncated]");
    expect(details.omitted).toBeGreaterThan(0);
    expect(text).toContain(`[${details.omitted} earliest messages left out]`);
    expect(text).toContain(`body ${n - 1}`);
    expect(text).not.toContain("From: p0@x.com\n");
  });

  test("control characters in older messages cannot push the newest out of the fence", async () => {
    // Each \x01 becomes a six-character escape inside the fence: the budget
    // has to count that form, or the fence cuts the end, the newest message.
    const g = fakeGoogle({
      "GET /threads/ctl": () => ({
        id: "ctl",
        messages: [
          ...Array.from({ length: 3 }, (_, i) => ({
            id: `m${i}`, threadId: "ctl", labelIds: ["INBOX"], snippet: `old ${i}`,
            payload: { mimeType: "text/plain", headers: [{ name: "From", value: `p${i}@x.com` }], body: { data: b64("\x01".repeat(7_000)) } },
          })),
          { id: "m3", threadId: "ctl", labelIds: ["INBOX"], snippet: "newest", payload: { mimeType: "text/plain", headers: [{ name: "From", value: "boss@x.com" }], body: { data: b64("NEWEST MESSAGE pay invoice 42") } } },
        ],
      }),
    });
    const { text, details } = await run(tool(g.deps, "read_thread"), { thread_id: "ctl" });
    expect(text).not.toContain("[truncated]");
    expect(text).toContain("NEWEST MESSAGE pay invoice 42\n</untrusted-");
    expect(details.shortened).toBeGreaterThan(0);
  });

  test("a newest message made only of control characters is cut by the tool, not the fence", async () => {
    const g = fakeGoogle({
      "GET /threads/ctl1": () => ({
        id: "ctl1",
        messages: [{ id: "m0", threadId: "ctl1", labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [{ name: "From", value: "p@x.com" }], body: { data: b64("\x01".repeat(8_000)) } } }],
      }),
    });
    const { text } = await run(tool(g.deps, "read_thread"), { thread_id: "ctl1" });
    expect(text).not.toContain("[truncated]");
    expect(text).toContain("[cut: the message goes on]\n</untrusted-");
  });

  test("messageText decodes a declared charset", () => {
    const latin1 = encodeBase64(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "base64url");
    expect(messageText({ mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }], body: { data: latin1 } }).text).toBe("café");
  });
});

const replyThread = {
  id: "t5",
  messages: [
    { id: "m1", threadId: "t5", labelIds: ["INBOX"], payload: { headers: [
      { name: "From", value: "Dana <dana@x.com>" },
      { name: "To", value: "me@example.com, Sam <sam@x.com>" },
      { name: "Cc", value: "lee@x.com" },
      { name: "Subject", value: "Dinner Friday" },
      { name: "Message-ID", value: "<m1@x.com>" },
    ] } },
    { id: "m2", threadId: "t5", labelIds: ["INBOX"], payload: { headers: [
      { name: "From", value: "Sam <sam@x.com>" },
      { name: "Reply-To", value: "sam.personal@y.com" },
      { name: "To", value: "Dana <dana@x.com>, me@example.com" },
      { name: "Cc", value: "lee@x.com" },
      { name: "Subject", value: "Re: Dinner Friday" },
      { name: "Message-ID", value: "<m2@x.com>" },
      { name: "References", value: "<m1@x.com>" },
    ] } },
  ],
};

describe("replies", () => {
  test("a reply goes to Reply-To, threads under the last message, and a reply-all leaves the person off", () => {
    expect(replyEnvelope(replyThread, false)).toEqual({
      to: ["sam.personal@y.com"],
      subject: "Re: Dinner Friday",
      inReplyTo: "<m2@x.com>",
      references: "<m1@x.com> <m2@x.com>",
    });
    expect(replyEnvelope(replyThread, true, "me@example.com").cc).toEqual(["Dana <dana@x.com>", "lee@x.com"]);
  });

  test("a thread that ends with the person's own message continues to its recipients", () => {
    const mine = { id: "t", messages: [{ id: "m", threadId: "t", labelIds: ["SENT"], payload: { headers: [
      { name: "From", value: "me@example.com" }, { name: "To", value: "dana@x.com" }, { name: "Subject", value: "Hello" },
    ] } }] };
    expect(replyEnvelope(mine, false)).toMatchObject({ to: ["dana@x.com"], subject: "Re: Hello" });
  });

  test("a draft in the thread is skipped: the reply answers the last sent message", () => {
    // draft_reply, then "change it" and draft_reply again: the thread now ends with the first draft.
    const withDraft = { id: "t", messages: [
      { id: "m1", threadId: "t", labelIds: ["INBOX"], payload: { headers: [
        { name: "From", value: "Alice <alice@x.com>" }, { name: "To", value: "me@example.com" },
        { name: "Subject", value: "Plans" }, { name: "Message-ID", value: "<a1@x.com>" },
      ] } },
      { id: "d1", threadId: "t", labelIds: ["DRAFT"], payload: { headers: [
        { name: "From", value: "me@example.com" }, { name: "To", value: "Alice <alice@x.com>" },
        { name: "Subject", value: "Re: Plans" }, { name: "Message-ID", value: "<draft1@mail.gmail.com>" },
        { name: "In-Reply-To", value: "<a1@x.com>" }, { name: "References", value: "<a1@x.com>" },
      ] } },
    ] };
    expect(replyEnvelope(withDraft, true, "me@example.com")).toEqual({
      to: ["Alice <alice@x.com>"],
      subject: "Re: Plans",
      inReplyTo: "<a1@x.com>",
      references: "<a1@x.com>",
    });
    expect(() => replyEnvelope({ id: "t", messages: [withDraft.messages[1]] }, false)).toThrow("no sent messages");
  });

  test("draft_reply saves a threaded draft and sends nothing", async () => {
    const g = fakeGoogle({
      "GET /profile": () => ({ emailAddress: "me@example.com" }),
      "GET /threads/t5": () => replyThread,
      "POST /drafts": () => ({ id: "d1", message: { id: "x", threadId: "t5" } }),
    });
    const { text, details } = await run(tool(g.deps, "draft_reply"), { thread_id: "t5", body: "Count me in.\nSee you", reply_all: true });
    const post = g.calls.find((c) => c.method === "POST")!;
    expect(post.url.pathname).toBe("/gmail/v1/users/me/drafts");
    expect(post.body.message.threadId).toBe("t5");
    const raw = unraw(post.body.message.raw);
    expect(raw).toContain("To: sam.personal@y.com\r\n");
    expect(raw).toContain("Cc: Dana <dana@x.com>, lee@x.com\r\n");
    expect(raw).toContain("In-Reply-To: <m2@x.com>\r\n");
    expect(bodyOf(post.body.message.raw)).toBe("Count me in.\r\nSee you");
    expect(g.calls.some((c) => c.url.pathname.endsWith("/send"))).toBe(false);
    expect(text).toContain("Draft saved (draft d1)");
    expect(details).toMatchObject({ draft_id: "d1" });
  });
});

describe("sending", () => {
  test("send_mail sends the exact message, in its thread when it answers one", async () => {
    const g = fakeGoogle({ "GET /threads/t5": () => replyThread, "POST /messages/send": () => ({ id: "s1", threadId: "t5" }) });
    const { text } = await run(tool(g.deps, "send_mail"), { to: ["sam@x.com"], subject: "Re: Dinner Friday", body: "Café at 7 ✓", thread_id: "t5" });
    const post = g.calls.find((c) => c.method === "POST")!;
    expect(post.body.threadId).toBe("t5");
    const raw = unraw(post.body.raw);
    expect(raw).toContain("In-Reply-To: <m2@x.com>");
    expect(bodyOf(post.body.raw)).toBe("Café at 7 ✓");
    expect(text).toBe('Sent to sam@x.com: "Re: Dinner Friday".');
    expect(g.tokenAsks.at(-1)?.scope).toBe(GMAIL_SEND_SCOPE);
  });

  test("a header value cannot smuggle a header of its own, and a non-ASCII subject is encoded", () => {
    const raw = unraw(buildRawMessage({ to: ["a@b.co"], subject: "Hi\r\nBcc: evil@x.com", body: "x" }));
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(raw).toContain("Subject: Hi Bcc: evil@x.com\r\n");
    expect(unraw(buildRawMessage({ to: ["a@b.co"], subject: "Café", body: "x" }))).toContain("Subject: =?UTF-8?B?Q2Fmw6k=?=");
    expect(() => buildRawMessage({ to: ["not an address"], subject: "s", body: "b" })).toThrow("is not one email address");
  });

  test("one recipient entry cannot hide a second recipient", () => {
    for (const sneaky of ["evil@x.com, Dana <dana@x.com>", "Dana; evil@x.com <dana@x.com>", "a@b.co c@d.co", "evil@x.com <dana@x.com>"]) {
      expect(() => buildRawMessage({ to: [sneaky], subject: "s", body: "b" })).toThrow("is not one email address");
    }
    const raw = unraw(buildRawMessage({ to: ['"Doe, Jane" <jane@x.com>', "Dana <dana@x.com>", "lee@x.com"], subject: "s", body: "b" }));
    expect(raw).toContain('To: "Doe, Jane" <jane@x.com>, Dana <dana@x.com>, lee@x.com\r\n');
  });

  test("an address reads as the one mail delivers to", () => {
    const quoted = '"<alice@x.com>" <eve@evil.com>';
    expect(unraw(buildRawMessage({ to: [quoted], subject: "s", body: "b" }))).toContain(`To: ${quoted}\r\n`);
    expect(bareAddress(quoted)).toBe("eve@evil.com");
    expect(deliveredAddress(quoted)).toBe("eve@evil.com");
    expect(deliveredAddress("Dana <Dana@X.com>")).toBe("dana@x.com");
    expect(deliveredAddress("alice@x.com <eve@evil.com>")).toBeNull();
    expect(deliveredAddress("Dana <dana@x.com>", "bare")).toBeNull();
    expect(deliveredAddress(" Lee@X.com ", "bare")).toBe("lee@x.com");
  });

  test("a connection without the grant says what to allow", async () => {
    const g = fakeGoogle({}, { granted: [GMAIL_READONLY_SCOPE] });
    await expect(runTool(tool(g.deps, "send_mail"), { to: ["a@b.co"], subject: "s", body: "b" }, { callId: "c" })).rejects.toThrow("allow gmail.modify from Connections");
    expect(g.calls).toHaveLength(0);
  });
});

describe("archive and label", () => {
  test("archive removes INBOX from each thread", async () => {
    const g = fakeGoogle({ "POST /threads/[^/]+/modify": () => ({}) });
    await run(tool(g.deps, "archive"), { thread_ids: ["t1", "t2"] });
    expect(g.calls.map((c) => [c.url.pathname.split("/")[6], c.body])).toEqual([
      ["t1", { removeLabelIds: ["INBOX"] }],
      ["t2", { removeLabelIds: ["INBOX"] }],
    ]);
  });

  test("label resolves names, creates a missing label, and refuses an unknown one to remove", async () => {
    const g = fakeGoogle({
      "GET /labels": () => ({ labels: [{ id: "STARRED", name: "STARRED" }, { id: "Label_1", name: "Receipts" }] }),
      "POST /labels": (c) => ({ id: "Label_2", name: c.body.name }),
      "POST /threads/[^/]+/modify": () => ({}),
    });
    const { text } = await run(tool(g.deps, "label"), { thread_ids: ["t1"], add: ["receipts", "Taxes 2026"], remove: ["starred"] });
    expect(g.calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/labels"))?.body).toEqual({ name: "Taxes 2026" });
    expect(g.calls.at(-1)?.body).toEqual({ addLabelIds: ["Label_1", "Label_2"], removeLabelIds: ["STARRED"] });
    expect(text).toBe("On 1 thread: added receipts, Taxes 2026 and removed starred.");
    await expect(runTool(tool(g.deps, "label"), { thread_ids: ["t1"], remove: ["Nope"] }, { callId: "c" })).rejects.toThrow('No label named "Nope"');
  });

  test("an unknown label to remove fails before any label is created or thread touched", async () => {
    const g = fakeGoogle({
      "GET /labels": () => ({ labels: [{ id: "Label_1", name: "Receipts" }] }),
      "POST /labels": (c) => ({ id: "Label_2", name: c.body.name }),
      "POST /threads/[^/]+/modify": () => ({}),
    });
    await expect(runTool(tool(g.deps, "label"), { thread_ids: ["t1"], add: ["Taxes 2026"], remove: ["Typo"] }, { callId: "c" })).rejects.toThrow('No label named "Typo"');
    expect(g.calls.map((c) => `${c.method} ${c.url.pathname.split("/").at(-1)}`)).toEqual(["GET labels"]);
  });
});

describe("which tools a grant offers", () => {
  test("read only, then modify, then send", () => {
    const names = (can: { read_mail: boolean; modify_mail: boolean; send_mail: boolean }) => gmailTools(fakeGoogle({}).deps, can).map((t) => `${t.name}:${t.risk}`);
    expect(names({ read_mail: true, modify_mail: false, send_mail: false })).toEqual(["search_mail:read", "read_thread:read"]);
    expect(names({ read_mail: true, modify_mail: true, send_mail: true })).toEqual([
      "search_mail:read", "read_thread:read", "draft_reply:read", "create_draft:read", "archive:write", "label:write", "send_mail:write",
    ]);
  });
});
