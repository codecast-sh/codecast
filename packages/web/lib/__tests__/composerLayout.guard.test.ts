import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "..", "components", "ConversationView.tsx"), "utf8");

test("the autosizing composer textarea does not create an inline baseline", () => {
  const textareaClass = source.match(/style=\{FIELD_SIZING_STYLE\}\s+className=\{`([^`]+)`\}/)?.[1];
  expect(textareaClass?.split(/\s+/)).toContain("block");
});
