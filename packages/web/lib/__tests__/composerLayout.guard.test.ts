import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "..", "components", "MessageInput.tsx"), "utf8");

test("the autosizing composer textarea does not create an inline baseline", () => {
  const textareaClass = source.match(/style=\{FIELD_SIZING_STYLE\}\s+className=\{`([^`]+)`\}/)?.[1];
  expect(textareaClass?.split(/\s+/)).toContain("block");
});

// A long draft must scroll inside the field, never grow the composer past the
// box that holds it. ComposeView's modal and dock are fixed frames that clip
// their overflow: before this cap, a long draft grew the textarea past the
// frame, focus scrolled the title bar and pickers out of the top, and the
// send row sat below the clip. The frame hands the composer a share of its
// own height through --composer-max-h, and the field caps itself on it.
const composeView = readFileSync(join(import.meta.dir, "..", "..", "components", "ComposeView.tsx"), "utf8");

test("the composer textarea caps its height on --composer-max-h and scrolls past it", () => {
  const textareaClass = source.match(/style=\{FIELD_SIZING_STYLE\}\s+className=\{`([^`]+)`\}/)?.[1]?.split(/\s+/) ?? [];
  expect(textareaClass).toContain("max-h-[var(--composer-max-h,45vh)]");
  expect(textareaClass).toContain("overflow-y-auto");
  expect(textareaClass).not.toContain("overflow-hidden");
});

test("the expanded editor box is bound by the same cap", () => {
  expect(source).toContain('composeMode ? "min-h-[min(40vh,var(--composer-max-h,40vh))] max-h-[var(--composer-max-h,45vh)]"');
});

test("ComposeView's modal and dock frames hand the composer a share of their height", () => {
  expect(composeView).toContain("[--composer-max-h:calc(var(--frame-h)*0.45)]");
  // Both sized frames declare --frame-h and take their height from it.
  expect(composeView).toContain("[--frame-h:min(88vh,680px)]");
  expect(composeView).toContain("[--frame-h:min(520px,calc(100vh-5rem))]");
  expect(composeView).toContain("h-[var(--frame-h)]");
});
