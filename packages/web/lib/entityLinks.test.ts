import { test, expect, describe } from "bun:test";
import {
  parseEntityUrl,
  parseSharedEntityUrl,
  isConvexId,
  buildEntityUrl,
  inferEntityTypeFromShortId,
  normalizeEntityType,
  entityRoute,
  entityTypeFromId,
  isEntityId,
  entityMentionRegex,
  bareEntityIdRegex,
  truncateEntityLabel,
  entityReferenceLabel,
  parseMessageRefUrl,
  parsePublishedPageUrl,
  messageRefPayload,
  parseMessageRefPayload,
  parseClaudeArtifactUrl,
  parseCallRef,
  callRefId,
  parseProposalChangeRef,
  proposalChangeRefId,
  proposalChangeLabelSuffix,
} from "./entityLinks";

const MSG_CONVEX_ID = "kx82qtvpbmmrmwcjqmhzawejsx8bq9gm";
const CONV_CONVEX_ID = "jx84qtvpbmmrmwcjqmhzawejsx8bq9gm";
const SHARE_TOKEN = "3f0c1b2a-7d4e-4c9a-9b1e-2a6f8c0d1e2f";

describe("parsePublishedPageUrl", () => {
  const slug = "FFbZwRRWhePH";

  test("recognizes the published page edge URL and existing share URLs", () => {
    for (const url of [
      `https://a.codecast.sh/${slug}`,
      `https://a.codecast.sh/${slug}/?v=2#section`,
      `https://a.codecast.sh/a/${slug}`,
      `https://codecast.sh/a/${slug}`,
      `https://convex.codecast.sh/cli/a/${slug}`,
      `http://localhost:3200/a/${slug}`,
      `/a/${slug}`,
    ]) expect(parsePublishedPageUrl(url)).toEqual({ slug });
  });

  test("rejects bundle assets, unrelated routes and foreign hosts", () => {
    for (const url of [
      `https://a.codecast.sh/${slug}/image.png`,
      `https://codecast.sh/${slug}`,
      `https://example.com/${slug}`,
      `https://a.codecast.sh.example.com/${slug}`,
      "https://a.codecast.sh/short",
      `/${slug}`,
    ]) expect(parsePublishedPageUrl(url)).toBeNull();
  });
});

describe("parseClaudeArtifactUrl", () => {
  const id = "2c5e5d6e-0a70-4e04-9c7a-1c4f1f5b8b6d";
  const url = `https://claude.ai/public/artifacts/${id}`;

  test("recognizes the share URL, the older claude.site host and the embed path", () => {
    for (const href of [
      url,
      `${url}/`,
      `${url}?x=1#top`,
      `${url}/embed`,
      `https://www.claude.ai/public/artifacts/${id}`,
      `https://claude.site/artifacts/${id}`,
      `https://claude.ai/public/artifacts/${id.toUpperCase()}`,
    ]) expect(parseClaudeArtifactUrl(href)).toEqual({ id, url });
  });

  test("rejects other claude.ai pages, non-uuid ids and foreign hosts", () => {
    for (const href of [
      "https://claude.ai/chat/abc",
      `https://claude.ai/public/artifacts/${id}/assets/x.png`,
      "https://claude.ai/public/artifacts/not-a-uuid",
      `https://example.com/public/artifacts/${id}`,
      `https://claude.ai.example.com/public/artifacts/${id}`,
      `/public/artifacts/${id}`,
    ]) expect(parseClaudeArtifactUrl(href)).toBeNull();
  });
});

describe("parseMessageRefUrl", () => {
  test("a /share/message link is a share reference", () => {
    expect(parseMessageRefUrl(`https://codecast.sh/share/message/${SHARE_TOKEN}`)).toEqual({ kind: "share", token: SHARE_TOKEN });
    expect(parseMessageRefUrl(`/share/message/${SHARE_TOKEN}`)).toEqual({ kind: "share", token: SHARE_TOKEN });
    expect(parseMessageRefUrl(`https://local.codecast.sh/share/message/${SHARE_TOKEN}?x=1`)).toEqual({ kind: "share", token: SHARE_TOKEN });
  });

  test("a conversation link with a #msg- fragment is an in-place reference", () => {
    expect(parseMessageRefUrl(`https://codecast.sh/conversation/${CONV_CONVEX_ID}#msg-${MSG_CONVEX_ID}`)).toEqual({ kind: "message", id: MSG_CONVEX_ID });
    expect(parseMessageRefUrl(`/conversation/${CONV_CONVEX_ID}#msg-${MSG_CONVEX_ID}`)).toEqual({ kind: "message", id: MSG_CONVEX_ID });
  });

  test("other share kinds, plain conversation links, and foreign hosts are not messages", () => {
    expect(parseMessageRefUrl(`https://codecast.sh/share/${SHARE_TOKEN}`)).toBeNull();
    expect(parseMessageRefUrl(`https://codecast.sh/share/doc/${SHARE_TOKEN}`)).toBeNull();
    expect(parseMessageRefUrl(`https://codecast.sh/conversation/${CONV_CONVEX_ID}`)).toBeNull();
    expect(parseMessageRefUrl(`https://codecast.sh/conversation/${CONV_CONVEX_ID}#msg-short`)).toBeNull();
    expect(parseMessageRefUrl(`https://example.com/share/message/${SHARE_TOKEN}`)).toBeNull();
    expect(parseMessageRefUrl("entity://msg:abc")).toBeNull();
    expect(parseMessageRefUrl(null)).toBeNull();
  });

  test("payloads round-trip and tell a token from a message id by shape", () => {
    const share = { kind: "share", token: SHARE_TOKEN } as const;
    const inPlace = { kind: "message", id: MSG_CONVEX_ID } as const;
    expect(messageRefPayload(share)).toBe(`msg:${SHARE_TOKEN}`);
    expect(messageRefPayload(inPlace)).toBe(`msg:${MSG_CONVEX_ID}`);
    expect(parseMessageRefPayload(messageRefPayload(share))).toEqual(share);
    expect(parseMessageRefPayload(messageRefPayload(inPlace))).toEqual(inPlace);
    expect(parseMessageRefPayload("msg:")).toBeNull();
    expect(parseMessageRefPayload("msg:has spaces")).toBeNull();
    expect(parseMessageRefPayload("ct-4102")).toBeNull();
  });
});

describe("isConvexId", () => {
  test("accepts a full 32-char Convex id", () => {
    expect(isConvexId("mh73xedd7ep2nmr082mqnxts2x86kzfy")).toBe(true);
    expect(isConvexId("jx75sqw53801qvexsvem39mbhh88c8wt")).toBe(true);
  });

  test("rejects a non-32-char id that the old >=20 heuristic wrongly accepted", () => {
    // 21 chars: long enough to pass the retired length>=20 test, but not a real
    // Convex id. Handing this to ctx.db.get throws "Invalid ID length 21" — the
    // crash this guards against. Must NOT look like a Convex id.
    expect("abcdefghij0123456789x".length).toBe(21);
    expect(isConvexId("abcdefghij0123456789x")).toBe(false);
  });

  test("rejects short ids and junk", () => {
    expect(isConvexId("ct-33527")).toBe(false);
    expect(isConvexId("pl-77")).toBe(false);
    expect(isConvexId("jx75sqw")).toBe(false);
    expect(isConvexId("")).toBe(false);
    expect(isConvexId("MH73XEDD7EP2NMR082MQNXTS2X86KZFY")).toBe(false); // uppercase
    expect(isConvexId("mh73xedd7ep2nmr082mqnxts2x86kzf")).toBe(false); // 31 chars
  });

  test("rejects a session UUID (optimistic-stub conversation id)", () => {
    // A freshly-created conversation renders from an optimistic stub keyed by its
    // session UUID until the server row syncs back. The collab queries validate
    // v.id("conversations"), so the CollabComposer/CollabRequestBanner guards on
    // isConvexId to skip while the id is still this UUID — otherwise the dashed
    // value crashes the whole Conversation view at arg validation.
    expect(isConvexId("3bb57a15-7619-4189-8349-b319813e224b")).toBe(false);
  });
});

describe("parseEntityUrl", () => {
  const CONVEX_ID = "mh73xedd7ep2nmr082mqnxts2x86kzfy";

  test("absolute production task URL (full Convex id) → task", () => {
    expect(parseEntityUrl(`https://codecast.sh/tasks/${CONVEX_ID}`)).toEqual({
      type: "task",
      id: CONVEX_ID,
    });
  });

  test("recognizes every entity route", () => {
    expect(parseEntityUrl(`https://codecast.sh/plans/${CONVEX_ID}`)?.type).toBe("plan");
    expect(parseEntityUrl(`https://codecast.sh/conversation/${CONVEX_ID}`)?.type).toBe("session");
    expect(parseEntityUrl(`https://codecast.sh/sessions/${CONVEX_ID}`)?.type).toBe("session");
    expect(parseEntityUrl(`https://codecast.sh/docs/${CONVEX_ID}`)?.type).toBe("doc");
    expect(parseEntityUrl(`https://codecast.sh/projects/${CONVEX_ID}`)?.type).toBe("project");
  });

  test("a link carrying its share token stays a link: a pill would drop the token", () => {
    expect(parseEntityUrl(`https://codecast.sh/conversation/${CONVEX_ID}?share=45539c23-e9a1-46f1-9d23-7261c49f11ec`)).toBeNull();
    expect(parseEntityUrl(`/conversation/${CONVEX_ID}?share=abc#msg-x`)).toBeNull();
  });

  test("a shared link still names its object, and opens through the token", () => {
    expect(parseSharedEntityUrl(`https://codecast.sh/conversation/${CONVEX_ID}?share=45539c23-e9a1-46f1-9d23-7261c49f11ec`)).toEqual({
      type: "session",
      id: CONVEX_ID,
      to: `/conversation/${CONVEX_ID}?share=45539c23-e9a1-46f1-9d23-7261c49f11ec`,
    });
    expect(parseSharedEntityUrl(`/conversation/${CONVEX_ID}?share=abc#msg-x`)?.to).toBe(`/conversation/${CONVEX_ID}?share=abc#msg-x`);
    expect(parseSharedEntityUrl(`https://codecast.sh/conversation/${CONVEX_ID}`)).toBeNull();
    expect(parseSharedEntityUrl(`https://example.com/conversation/${CONVEX_ID}?share=abc`)).toBeNull();
  });

  test("short ids keep their original form", () => {
    expect(parseEntityUrl("https://codecast.sh/tasks/ct-33527")).toEqual({ type: "task", id: "ct-33527" });
    expect(parseEntityUrl("https://codecast.sh/plans/pl-77")).toEqual({ type: "plan", id: "pl-77" });
  });

  test("path-only hrefs work and drop query/hash", () => {
    expect(parseEntityUrl(`/tasks/${CONVEX_ID}`)).toEqual({ type: "task", id: CONVEX_ID });
    expect(parseEntityUrl(`/tasks/${CONVEX_ID}?focus=1#msg-1`)).toEqual({ type: "task", id: CONVEX_ID });
  });

  test("dev and localhost origins are recognized", () => {
    expect(parseEntityUrl(`https://local.codecast.sh/tasks/${CONVEX_ID}`)?.type).toBe("task");
    expect(parseEntityUrl(`http://localhost:3000/tasks/${CONVEX_ID}`)?.type).toBe("task");
  });

  test("non-entity app paths are left alone", () => {
    expect(parseEntityUrl("https://codecast.sh/settings/profile")).toBeNull();
    expect(parseEntityUrl("https://codecast.sh/login")).toBeNull();
    expect(parseEntityUrl("https://codecast.sh/share/abc123")).toBeNull();
    expect(parseEntityUrl("https://codecast.sh/tasks")).toBeNull(); // list, no id
  });

  test("foreign hosts never become pills", () => {
    expect(parseEntityUrl(`https://evil.com/tasks/${CONVEX_ID}`)).toBeNull();
    expect(parseEntityUrl("https://github.com/ashot/codecast")).toBeNull();
    // host that merely contains the string but isn't ours
    expect(parseEntityUrl(`https://codecast.sh.evil.com/tasks/${CONVEX_ID}`)).toBeNull();
  });

  test("other protocols and junk return null", () => {
    expect(parseEntityUrl("mailto:ashot@example.com")).toBeNull();
    expect(parseEntityUrl("entity://ct-1")).toBeNull();
    expect(parseEntityUrl("")).toBeNull();
    expect(parseEntityUrl(undefined)).toBeNull();
    expect(parseEntityUrl("not a url")).toBeNull();
  });
});

describe("buildEntityUrl", () => {
  const CONVEX_ID = "mh73xedd7ep2nmr082mqnxts2x86kzfy";

  test("each entity type maps to its public route", () => {
    expect(buildEntityUrl("task", "ct-37187")).toBe("https://codecast.sh/tasks/ct-37187");
    expect(buildEntityUrl("plan", "pl-42")).toBe("https://codecast.sh/plans/pl-42");
    expect(buildEntityUrl("session", CONVEX_ID)).toBe(`https://codecast.sh/conversation/${CONVEX_ID}`);
    expect(buildEntityUrl("doc", CONVEX_ID)).toBe(`https://codecast.sh/docs/${CONVEX_ID}`);
    expect(buildEntityUrl("project", "pj-1")).toBe("https://codecast.sh/projects/pj-1");
  });

  test("accepts url-segment aliases and a custom base (trailing slash trimmed)", () => {
    expect(buildEntityUrl("conversation", CONVEX_ID)).toBe(`https://codecast.sh/conversation/${CONVEX_ID}`);
    expect(buildEntityUrl("tasks", "ct-1", "http://localhost:3000/")).toBe("http://localhost:3000/tasks/ct-1");
  });

  test("round-trips with parseEntityUrl", () => {
    const url = buildEntityUrl("task", CONVEX_ID)!;
    expect(parseEntityUrl(url)).toEqual({ type: "task", id: CONVEX_ID });
  });

  test("unknown type yields null", () => {
    expect(buildEntityUrl("widget", "x")).toBeNull();
  });
});

describe("inferEntityTypeFromShortId", () => {
  test("recognizes ct-/pl- prefixes, nothing else", () => {
    expect(inferEntityTypeFromShortId("ct-37187")).toBe("task");
    expect(inferEntityTypeFromShortId("pl-42")).toBe("plan");
    // 7-char session short ids and full Convex ids have no distinguishing prefix.
    expect(inferEntityTypeFromShortId("jx70ntf")).toBeNull();
    expect(inferEntityTypeFromShortId("mh73xedd7ep2nmr082mqnxts2x86kzfy")).toBeNull();
    expect(inferEntityTypeFromShortId("")).toBeNull();
  });
});

describe("normalizeEntityType", () => {
  test("canonical types and aliases normalize; junk is null", () => {
    expect(normalizeEntityType("session")).toBe("session");
    expect(normalizeEntityType("conversation")).toBe("session");
    expect(normalizeEntityType("tasks")).toBe("task");
    expect(normalizeEntityType("docs")).toBe("doc");
    expect(normalizeEntityType("widget")).toBeNull();
  });
});

const A_CONVEX_ID = "mh73xedd7ep2nmr082mqnxts2x86kzfy";

describe("triggers as first-class referenceable objects", () => {
  // Regression: a trigger id in agent prose rendered as a raw 32-char blob
  // (`Trigger \`rx72qtvpbmmrmwcjqmhzawejsx8bq9gm\` marked complete`) because the
  // trigger type was never registered here — no short-id prefix, no route, no
  // url segment. Everything below is what registering it must buy.

  test("tr- short ids resolve to the trigger type", () => {
    expect(inferEntityTypeFromShortId("tr-42")).toBe("trigger");
    expect(inferEntityTypeFromShortId("TR-42")).toBe("trigger");
    expect(entityTypeFromId("tr-42")).toBe("trigger");
  });

  test("a trigger routes to its detail page", () => {
    expect(entityRoute("trigger", "tr-42")).toBe("/triggers/tr-42");
    expect(buildEntityUrl("trigger", "tr-42")).toBe("https://codecast.sh/triggers/tr-42");
  });

  test("a trigger url round-trips back to { type, id }", () => {
    expect(parseEntityUrl("https://codecast.sh/triggers/tr-42")).toEqual({
      type: "trigger",
      id: "tr-42",
    });
    // Legacy ?task= links (pre-detail-page) still resolve, in both spellings.
    expect(parseEntityUrl("https://codecast.sh/triggers?task=tr-42")).toEqual({
      type: "trigger",
      id: "tr-42",
    });
    // The gear-verb deep link from the inbox uses the full Convex id.
    expect(parseEntityUrl(`/triggers?task=${A_CONVEX_ID}`)).toEqual({
      type: "trigger",
      id: A_CONVEX_ID,
    });
    // Pre-rename alias still resolves.
    expect(parseEntityUrl("/schedules?task=tr-7")).toEqual({ type: "trigger", id: "tr-7" });
    expect(parseEntityUrl("/schedules/tr-7")).toEqual({ type: "trigger", id: "tr-7" });
    // The bare list page addresses no single object.
    expect(parseEntityUrl("/triggers")).toBeNull();
  });

  test("query-addressed parsing does not swallow path-addressed types", () => {
    expect(parseEntityUrl("/tasks/ct-1?from=inbox")).toEqual({ type: "task", id: "ct-1" });
    expect(parseEntityUrl("/tasks")).toBeNull();
  });
});

describe("entityTypeFromId", () => {
  test("types every id shape that carries its own type", () => {
    expect(entityTypeFromId("ct-4102")).toBe("task");
    expect(entityTypeFromId("pl-88")).toBe("plan");
    expect(entityTypeFromId("tr-42")).toBe("trigger");
    expect(entityTypeFromId("jx7c6zk")).toBe("session");
    expect(entityTypeFromId(`doc:${A_CONVEX_ID}`)).toBe("doc");
  });

  test("a bare Convex id carries no type and must be resolved server-side", () => {
    // A Convex id can even start with "jx" — prefix sniffing would call it a
    // session and query the wrong table.
    expect(entityTypeFromId(A_CONVEX_ID)).toBeNull();
    expect(entityTypeFromId("jx75sqw53801qvexsvem39mbhh88c8wt")).toBeNull();
  });
});

describe("isEntityId", () => {
  test("accepts every registered handle", () => {
    for (const id of ["ct-4102", "pl-88", "tr-42", "jx7c6zk", A_CONVEX_ID]) {
      expect(isEntityId(id)).toBe(true);
    }
  });

  test("rejects ordinary words and partial ids", () => {
    expect(isEntityId("trigger")).toBe(false);
    expect(isEntityId("tr-")).toBe(false);
    expect(isEntityId("hello world")).toBe(false);
    expect(isEntityId("")).toBe(false);
  });
});

describe("entityMentionRegex", () => {
  test("captures the title and id of an @[Title id] mention", () => {
    const m = entityMentionRegex().exec("see @[Growth audit tr-42] for details");
    expect(m?.[1]).toBe("Growth audit");
    expect(m?.[2]).toBe("tr-42");
  });

  test("returns a fresh regex each call, so callers cannot poison lastIndex", () => {
    const a = entityMentionRegex();
    a.exec("@[One ct-1] @[Two ct-2]");
    expect(a.lastIndex).toBeGreaterThan(0);
    expect(entityMentionRegex().lastIndex).toBe(0);
  });

  test("requireId skips a bare @[Name] person mention", () => {
    expect(entityMentionRegex({ requireId: true }).test("hi @[Ashot]")).toBe(false);
    expect(entityMentionRegex().test("hi @[Ashot]")).toBe(true);
  });
});

describe("bareEntityIdRegex", () => {
  test("finds every object handle in a sentence", () => {
    const text = "Filed ct-4102 under pl-88, trigger tr-42 fires hourly; see jx7c6zk.";
    expect(text.match(bareEntityIdRegex())).toEqual(["ct-4102", "pl-88", "tr-42", "jx7c6zk"]);
  });

  test("does not match a word that merely starts with a prefix", () => {
    expect("the transaction triggered a plan".match(bareEntityIdRegex())).toBeNull();
  });
});

describe("truncateEntityLabel", () => {
  test("leaves an ordinary title alone", () => {
    expect(truncateEntityLabel("Retry queue for failed webhooks")).toBe(
      "Retry queue for failed webhooks",
    );
  });

  test("leaves a title alone when clipping would save a character or two", () => {
    // 42 chars — over the 40 budget, but clipping it buys nothing and costs a
    // word, so it stays whole.
    const title = "Move every customer to the new webhook API";
    expect(title.length).toBeGreaterThan(40);
    expect(truncateEntityLabel(title)).toBe(title);
  });

  test("clips a long title on a word boundary", () => {
    expect(
      truncateEntityLabel("Rewrite the delivery pipeline so queued sends survive a restart"),
    ).toBe("Rewrite the delivery pipeline so queued…");
  });

  test("clips mid-word rather than collapsing to almost nothing", () => {
    // The only space inside the budget sits at index 3. Breaking there would
    // leave "Fix…", which names nothing — so the mid-word cut stands instead.
    const title = "Fix theincrediblylongidentifierwithnobreaksatall in the parser";
    const label = truncateEntityLabel(title);
    expect(label).toBe(title.slice(0, 40) + "…");
    expect(label.startsWith("Fix theincredibly")).toBe(true);
  });
});

describe("entityReferenceLabel", () => {
  test("prefers the title", () => {
    expect(
      entityReferenceLabel({ title: "Billing migration", shortId: "pl-88", rawId: "pl-88" }),
    ).toBe("Billing migration");
  });

  test("falls back to the short id while the row is unresolved", () => {
    expect(entityReferenceLabel({ title: null, shortId: null, rawId: "ct-38940" })).toBe("ct-38940");
  });

  test("never shows a raw 32-char Convex id", () => {
    const blob = "mh73xedd7ep2nmr082mqnxts2x86kzfy";
    expect(entityReferenceLabel({ rawId: blob, typeLabel: "Task" })).toBe("Task");
  });

  test("an empty title is not a title", () => {
    expect(entityReferenceLabel({ title: "   ", shortId: "ct-7", rawId: "ct-7" })).toBe("ct-7");
  });
});

describe("initiatives (in-N)", () => {
  // `in` is the one registered prefix that is also an English word, so it
  // takes digits only. The rule lives in the registry, and every matcher
  // (prose, mentions, the editor's scanner) derives from it.
  test("in-N resolves to the initiative type, whatever its case", () => {
    expect(inferEntityTypeFromShortId("in-7")).toBe("initiative");
    expect(entityTypeFromId("IN-12")).toBe("initiative");
    expect(isEntityId("in-7")).toBe(true);
  });

  test("an id inside a hyphenated word is prose", () => {
    for (const prose of ["a 2-in-1 vacuum", "an all-in-1 kit", "the op-1-style card", "x-ct-4102 and ct-4102-ish"]) {
      expect(prose.match(bareEntityIdRegex())).toBeNull();
    }
    expect("see in-1, op-1 and sd-2.".match(bareEntityIdRegex())).toEqual(["in-1", "op-1", "sd-2"]);
  });

  test("prose that starts with in- is never an initiative", () => {
    for (const word of ["in-app", "in-house", "in-flight", "in-7th", "in-"]) {
      expect(inferEntityTypeFromShortId(word)).toBeNull();
      expect(isEntityId(word)).toBe(false);
    }
    const prose = "We ship in-app fixes for in-7 and IN-12 (see ct-4102), all in-house, by the in-7th week.";
    expect(prose.match(bareEntityIdRegex())).toEqual(["in-7", "IN-12", "ct-4102"]);
  });

  test("an @[Title in-N] mention carries the id, and a prose word does not", () => {
    expect(entityMentionRegex().exec("see @[Win enterprise in-7] today")?.slice(1, 3)).toEqual(["Win enterprise", "in-7"]);
    // "in-app" stays part of the title: the id group is empty.
    expect(entityMentionRegex().exec("the @[checkout in-app] flow")?.slice(1, 3)).toEqual(["checkout in-app", undefined]);
  });

  test("an initiative routes to its own goal page and its url parses back, old addresses included", () => {
    expect(entityRoute("initiative", "in-7")).toBe("/goals/in-7");
    expect(buildEntityUrl("initiative", "in-7")).toBe("https://codecast.sh/goals/in-7");
    expect(parseEntityUrl("https://codecast.sh/org/in-7")).toEqual({ type: "initiative", id: "in-7" });
    expect(parseEntityUrl("https://codecast.sh/goals/in-7")).toEqual({ type: "initiative", id: "in-7" });
    expect(parseEntityUrl("https://codecast.sh/initiatives/in-7")).toEqual({ type: "initiative", id: "in-7" });
    expect(normalizeEntityType("initiatives")).toBe("initiative");
  });
});

describe("proposals (op-N)", () => {
  // `op` is an English word too (op-ed), so a proposal takes digits only, and
  // its page is the org page with the proposal open: addressed by query.
  test("op-N resolves to the proposal type, whatever its case", () => {
    expect(inferEntityTypeFromShortId("op-3")).toBe("proposal");
    expect(entityTypeFromId("OP-12")).toBe("proposal");
    expect(isEntityId("op-3")).toBe(true);
  });

  test("prose that starts with op- is never a proposal", () => {
    for (const word of ["op-ed", "op-amp", "op-3rd", "op-"]) {
      expect(inferEntityTypeFromShortId(word)).toBeNull();
      expect(isEntityId(word)).toBe(false);
    }
    const prose = "The op-ed names op-3 and OP-12 (see ct-4102) by the op-3rd draft.";
    expect(prose.match(bareEntityIdRegex())).toEqual(["op-3", "OP-12", "ct-4102"]);
  });

  test("a proposal routes to the org page by query and its url parses back", () => {
    expect(entityRoute("proposal", "op-3")).toBe("/org?proposal=op-3");
    expect(buildEntityUrl("proposal", "op-3")).toBe("https://codecast.sh/org?proposal=op-3");
    expect(parseEntityUrl("https://codecast.sh/org?proposal=op-3")).toEqual({ type: "proposal", id: "op-3" });
    expect(parseEntityUrl("/org?proposal=op-3")).toEqual({ type: "proposal", id: "op-3" });
    // The org page alone names no proposal, and a role's sheet under it names the role.
    expect(parseEntityUrl("/org")).toBeNull();
    expect(parseEntityUrl("https://codecast.sh/org/or-7")).toEqual({ type: "role", id: "or-7" });
    expect(normalizeEntityType("org")).toBe("proposal");
  });

  // One change of a proposal is written `op-55#3`: still a proposal
  // reference, with the change's number riding along.
  test("op-N#seq is a proposal reference that names one change", () => {
    expect(entityTypeFromId("op-55#3")).toBe("proposal");
    expect(entityTypeFromId("OP-55#3")).toBe("proposal");
    expect(isEntityId("op-55#3")).toBe(true);
    expect(parseProposalChangeRef("OP-55#3")).toEqual({ proposal: "op-55", seq: 3 });
    expect(proposalChangeRefId("op-55", 3)).toBe("op-55#3");
    expect(parseProposalChangeRef(proposalChangeRefId("op-55", 3))).toEqual({ proposal: "op-55", seq: 3 });
    for (const not of ["op-55", "op-55#", "op-55#x", "op-55#3x", "ct-55#3", "op-ed#3", "", null, undefined]) {
      expect(parseProposalChangeRef(not)).toBeNull();
    }
    expect(proposalChangeLabelSuffix(parseProposalChangeRef("op-55#3"))).toBe(" #3");
    expect(proposalChangeLabelSuffix(parseProposalChangeRef("op-55"))).toBe("");
  });

  test("prose scans the change reference whole, and only a real one", () => {
    expect("see op-55#3 next".match(bareEntityIdRegex())).toEqual(["op-55#3"]);
    expect("Start with op-55#1, then op-54#10.".match(bareEntityIdRegex())).toEqual(["op-55#1", "op-54#10"]);
    // A dangling or worded tail is the whole proposal followed by text.
    expect("op-55# and op-55#x".match(bareEntityIdRegex())).toEqual(["op-55", "op-55"]);
    for (const word of ["op-55#", "op-55#x"]) expect(isEntityId(word)).toBe(false);
    // A mention carries the same form.
    const m = entityMentionRegex({ requireId: true }).exec("@[Make Infrastructure the top priority op-55#3]");
    expect(m?.[2]).toBe("op-55#3");
  });

  test("a change routes to the org page with it in focus and its url parses back", () => {
    expect(entityRoute("proposal", "op-55#3")).toBe("/org?proposal=op-55&focus=3");
    expect(buildEntityUrl("proposal", "op-55#3")).toBe("https://codecast.sh/org?proposal=op-55&focus=3");
    expect(parseEntityUrl("https://codecast.sh/org?proposal=op-55&focus=3")).toEqual({ type: "proposal", id: "op-55#3" });
    expect(parseEntityUrl("/org?proposal=op-55&focus=3")).toEqual({ type: "proposal", id: "op-55#3" });
    // A focus on a goal or a role is the whole proposal, as is none at all.
    expect(parseEntityUrl("/org?proposal=op-55&focus=in-4")).toEqual({ type: "proposal", id: "op-55" });
    expect(parseEntityUrl("/org?proposal=op-55&focus=@head-of-growth")).toEqual({ type: "proposal", id: "op-55" });
    expect(parseEntityUrl("/org?proposal=op-55&focus=")).toEqual({ type: "proposal", id: "op-55" });
  });

  test("a pull request still owns owner/repo#N", () => {
    expect(entityTypeFromId("owner/repo#482")).toBe("pr");
    expect(parseProposalChangeRef("owner/repo#482")).toBeNull();
    expect("merged op-team/op-55#3 today".match(bareEntityIdRegex())).toEqual(["op-team/op-55#3"]);
    expect(entityTypeFromId("op-team/op-55#3")).toBe("pr");
  });
});

describe("decisions (sd-N)", () => {
  // A decision takes digits only, so "sd-card" in prose stays prose, and its
  // page is /decisions/<sd-N>.
  test("sd-N resolves to the decision type, and sd- prose does not", () => {
    expect(entityTypeFromId("sd-289")).toBe("decision");
    expect(isEntityId("SD-12")).toBe(true);
    for (const word of ["sd-card", "sd-xl", "sd-"]) expect(isEntityId(word)).toBe(false);
    const prose = "Wait on the sign up (decision sd-289). The sd-card is fine.";
    expect(prose.match(bareEntityIdRegex())).toEqual(["sd-289"]);
  });

  test("a decision routes to its page and its url parses back", () => {
    expect(entityRoute("decision", "sd-289")).toBe("/decisions/sd-289");
    expect(parseEntityUrl("https://codecast.sh/decisions/sd-289")).toEqual({ type: "decision", id: "sd-289" });
    // A stack's page is not a decision.
    expect(parseEntityUrl("/decisions/stacks/ds-3")?.type).not.toBe("decision");
    expect(parseEntityUrl("/decisions/stacks")?.type).not.toBe("decision");
  });
});

describe("calls (cl-N) and their lines (cl-N:a-b)", () => {
  const CALL_ID = "k57abcdefghijkmnpqrstvwxyz234567";
  test("a call and a stretch of it are both call references; prose is not", () => {
    expect(entityTypeFromId("cl-42")).toBe("call");
    expect(entityTypeFromId("cl-42:15-25")).toBe("call");
    expect(entityTypeFromId(`${CALL_ID}:7`)).toBe("call");
    for (const word of ["cl-ear", "cl-", "cl-42:"]) expect(isEntityId(word)).toBe(false);
    const prose = "Ashot said it on cl-42, and again here:\ncl-42:15-25\nsee cl-7:3.";
    expect(prose.match(bareEntityIdRegex())).toEqual(["cl-42", "cl-42:15-25", "cl-7:3"]);
  });

  test("parseCallRef splits the call from its lines, in order", () => {
    expect(parseCallRef("cl-42")).toEqual({ call: "cl-42", turns: null });
    expect(parseCallRef("CL-42:25-15")).toEqual({ call: "cl-42", turns: { from_seq: 15, to_seq: 25 } });
    expect(parseCallRef("cl-42:9")).toEqual({ call: "cl-42", turns: { from_seq: 9, to_seq: 9 } });
    // A bare full id names no type; only with lines is it known to be a call.
    expect(parseCallRef(CALL_ID)).toBeNull();
    expect(callRefId("cl-42", { from_seq: 9, to_seq: 9 })).toBe("cl-42:9");
    expect(callRefId("cl-42", { from_seq: 9, to_seq: 12 })).toBe("cl-42:9-12");
  });

  test("a call routes to its page with the lines selected, and the link parses back", () => {
    expect(entityRoute("call", "cl-42")).toBe("/calls/cl-42");
    expect(entityRoute("call", `${CALL_ID}:15-25`)).toBe(`/calls/${CALL_ID}?turns=15-25`);
    expect(parseEntityUrl(`https://codecast.sh/calls/${CALL_ID}?turns=15-25`)).toEqual({ type: "call", id: `${CALL_ID}:15-25` });
    expect(parseEntityUrl(`/calls/${CALL_ID}`)).toEqual({ type: "call", id: CALL_ID });
  });
});

describe("product sources (src-N)", () => {
  // `src` is a path segment (src-tauri), so a source takes digits only, and
  // its page is the Ops timeline narrowed to it: addressed by query.
  test("src-N resolves to the source type, and paths are never sources", () => {
    expect(inferEntityTypeFromShortId("src-13")).toBe("source");
    expect(entityTypeFromId("SRC-2")).toBe("source");
    for (const word of ["src-tauri", "src-gen", "src-"]) expect(isEntityId(word)).toBe(false);
    const prose = "| src-11 codecast-web (SDK) |\nsrc-13 stays in error; packages/src-tauri is a path.";
    expect(prose.match(bareEntityIdRegex())).toEqual(["src-11", "src-13"]);
  });

  test("a source routes to the Ops timeline by query and its url parses back", () => {
    expect(entityRoute("source", "src-13")).toBe("/ops?source=src-13");
    expect(parseEntityUrl("https://codecast.sh/ops?source=src-13")).toEqual({ type: "source", id: "src-13" });
    // Ops itself, its tabs and its issue pages name no source.
    expect(parseEntityUrl("/ops")).toBeNull();
    expect(parseEntityUrl("/ops/issues?source=src-13")).toBeNull();
    expect(parseEntityUrl("/ops/issues/eg-4")).toBeNull();
  });
});

describe("replays (rp-N) and their moments (rp-N@m:ss)", () => {
  // `rp` takes digits only, and a moment or stretch rides the same reference
  // (the player opens there), the way a call moment does.
  test("rp-N, a moment and a stretch are replay references; words are not", () => {
    expect(inferEntityTypeFromShortId("rp-12")).toBe("replay");
    expect(entityTypeFromId("rp-12@1:23")).toBe("replay");
    expect(entityTypeFromId("rp-12@1:00-2:30")).toBe("replay");
    expect(entityTypeFromId("rp-12@1:99")).toBe(null);
    for (const word of ["rp-x", "rp-", "rp-tauri"]) expect(isEntityId(word)).toBe(false);
    const prose = "Saw it at rp-12@1:23, and again in rp-3@0:10-0:40 (rp-4 too).";
    expect(prose.match(bareEntityIdRegex())).toEqual(["rp-12@1:23", "rp-3@0:10-0:40", "rp-4"]);
  });

  test("a replay opens its Ops page, a moment opens it at that time, and the link reads back", () => {
    expect(entityRoute("replay", "rp-12")).toBe("/ops/replays/rp-12");
    // ?t is seconds, as PostHog's and Sentry's links write it.
    expect(entityRoute("replay", "rp-12@1:23")).toBe("/ops/replays/rp-12?t=83");
    expect(entityRoute("replay", "rp-12@1:00-2:30")).toBe("/ops/replays/rp-12?t=60");
    expect(parseEntityUrl("https://codecast.sh/ops/replays/rp-12?t=83.5")).toEqual({ type: "replay", id: "rp-12@1:23" });
    expect(parseEntityUrl("https://codecast.sh/ops/replays/rp-12?t=1m23s")).toEqual({ type: "replay", id: "rp-12@1:23" });
    expect(parseEntityUrl("/ops/replays/rp-12")).toEqual({ type: "replay", id: "rp-12" });
    // The rest of Ops is still a source or a view.
    expect(parseEntityUrl("/ops?source=src-2")).toEqual({ type: "source", id: "src-2" });
    expect(parseEntityUrl("/ops/replays")).toBe(null);
  });
});
