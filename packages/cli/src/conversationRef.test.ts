import { describe, expect, test } from "bun:test";
import { parseConversationRef, buildConversationUrl } from "./conversationRef.js";
import { buildEntityUrl, entityTypeFromId } from "@codecast/shared/entities";

const CONV = "jx7e3hbj5n0a5xkcnz1s5bmrmd88ecjs";
const MSG = "k179h3pn6qjgwwzwa927r94kah88ev1e";

describe("parseConversationRef", () => {
  test("bare conversation id passes through unchanged", () => {
    expect(parseConversationRef(CONV)).toEqual({ conversationId: CONV, messageId: undefined });
  });

  test("full share URL with #msg- anchor splits into conv + message id", () => {
    expect(parseConversationRef(`https://codecast.sh/conversation/${CONV}#msg-${MSG}`)).toEqual({
      conversationId: CONV,
      messageId: MSG,
    });
  });

  test("id with #msg- fragment but no scheme", () => {
    expect(parseConversationRef(`${CONV}#msg-${MSG}`)).toEqual({
      conversationId: CONV,
      messageId: MSG,
    });
  });

  test("fragment without the msg- prefix is still treated as a message id", () => {
    expect(parseConversationRef(`${CONV}#${MSG}`)).toEqual({
      conversationId: CONV,
      messageId: MSG,
    });
  });

  test("URL without a fragment yields no message id", () => {
    expect(parseConversationRef(`https://codecast.sh/conversation/${CONV}`)).toEqual({
      conversationId: CONV,
      messageId: undefined,
    });
  });

  test("query string after the conversation id is stripped", () => {
    expect(parseConversationRef(`https://codecast.sh/conversation/${CONV}?ref=feed#msg-${MSG}`)).toEqual({
      conversationId: CONV,
      messageId: MSG,
    });
  });

  test("surrounding whitespace is trimmed", () => {
    expect(parseConversationRef(`  ${CONV}#msg-${MSG}  `)).toEqual({
      conversationId: CONV,
      messageId: MSG,
    });
  });

  test("empty input is handled gracefully", () => {
    expect(parseConversationRef("")).toEqual({ conversationId: "", messageId: undefined });
  });

  // `cast link op-55#3` printed the whole proposal's URL, and a pull request
  // lost its number the same way, because the # was read as a message anchor.
  test("an id that types whole keeps its #", () => {
    expect(parseConversationRef("op-55#3")).toEqual({ conversationId: "op-55#3" });
    expect(parseConversationRef("  OP-55#3 ")).toEqual({ conversationId: "OP-55#3" });
    expect(parseConversationRef("owner/repo#482")).toEqual({ conversationId: "owner/repo#482" });
  });

  test("a session with a message anchor and a share URL still split", () => {
    expect(parseConversationRef("jx7abc#msg-x")).toEqual({ conversationId: "jx7abc", messageId: "x" });
    expect(parseConversationRef("jx7csbd#msg-x")).toEqual({ conversationId: "jx7csbd", messageId: "x" });
    expect(parseConversationRef(`https://codecast.sh/conversation/${CONV}#msg-${MSG}`)).toEqual({
      conversationId: CONV,
      messageId: MSG,
    });
    // A proposal with a tail that is not a change number is not an id as a whole.
    expect(parseConversationRef("op-55#msg-x")).toEqual({ conversationId: "op-55", messageId: "x" });
  });

  test("cast link's path from a change reference: typed as a proposal, addressed with the change in focus", () => {
    const { conversationId } = parseConversationRef("op-55#3");
    expect(entityTypeFromId(conversationId)).toBe("proposal");
    expect(buildEntityUrl("proposal", conversationId)).toBe("https://codecast.sh/org?proposal=op-55&focus=3");
    const pr = parseConversationRef("owner/repo#482").conversationId;
    expect(entityTypeFromId(pr)).toBe("pr");
    expect(buildEntityUrl("pr", pr)).toBe("https://codecast.sh/pr/owner/repo/482");
  });
});

describe("buildConversationUrl", () => {
  test("conversation id without an anchor", () => {
    expect(buildConversationUrl({ conversationId: CONV })).toBe(
      `https://codecast.sh/conversation/${CONV}`,
    );
  });

  test("conversation id with a message anchor", () => {
    expect(buildConversationUrl({ conversationId: CONV, messageId: MSG })).toBe(
      `https://codecast.sh/conversation/${CONV}#msg-${MSG}`,
    );
  });

  test("custom base host, trailing slash trimmed", () => {
    expect(buildConversationUrl({ conversationId: CONV, messageId: MSG }, "http://localhost:3000/")).toBe(
      `http://localhost:3000/conversation/${CONV}#msg-${MSG}`,
    );
  });

  test("round-trips with parseConversationRef", () => {
    const ref = { conversationId: CONV, messageId: MSG };
    expect(parseConversationRef(buildConversationUrl(ref))).toEqual(ref);
    const noAnchor = { conversationId: CONV, messageId: undefined };
    expect(parseConversationRef(buildConversationUrl(noAnchor))).toEqual(noAnchor);
  });
});
