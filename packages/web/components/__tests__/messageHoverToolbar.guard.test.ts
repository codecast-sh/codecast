import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../conversation/blocks/turnBlocks.tsx", import.meta.url), "utf8");

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

test("the per-reply fork action is a named icon, with no word beside it", () => {
  const start = source.indexOf('title="Fork the conversation from this message"');
  expect(start).toBeGreaterThan(-1);
  const button = source.slice(start, source.indexOf("</button>", start));
  expect(button).toContain('aria-label="Fork from this message"');
  expect(button).toContain("<Split ");
  expect(button).not.toMatch(/>\s*Fork[^<]*</);
});
