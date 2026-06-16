import { describe, expect, test } from "bun:test";
import { parseConversationRef } from "./conversationRef.js";

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
});
