import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../ConversationView.tsx", import.meta.url), "utf8");

function toolbarMarkup(attribute: string) {
  const start = source.indexOf(`<div ${attribute}`);
  return source.slice(start, source.indexOf("}>", start) + 2);
}

test("message actions stay inert until their own message is hovered or focused", () => {
  const hidden = '"opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto"';
  const userToolbar = toolbarMarkup("data-cc-user-message-toolbar");
  const assistantToolbar = toolbarMarkup("data-cc-assistant-message-toolbar");

  expect(userToolbar).toContain(hidden);
  expect(assistantToolbar).toContain(hidden);
  expect(userToolbar).not.toMatch(/:\s*"opacity-100"/);
});

test("the per-reply fork action uses the compact label", () => {
  expect(source).toContain("<span>Fork</span>");
  expect(source).not.toContain("<span>Fork here</span>");
});
