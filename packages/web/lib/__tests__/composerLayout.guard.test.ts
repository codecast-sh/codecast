import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "..", "components", "MessageInput.tsx"), "utf8");

test("the autosizing composer textarea does not create an inline baseline", () => {
  const textareaClass = source.match(/style=\{FIELD_SIZING_STYLE\}\s+className=\{`([^`]+)`\}/)?.[1];
  expect(textareaClass?.split(/\s+/)).toContain("block");
});

// A long draft must scroll inside the field, never grow the composer past the
// box that holds it. ComposeView's frames clip their overflow: before this
// cap, a long draft grew the textarea past the frame, focus scrolled the
// title bar and pickers out of the top, and the send row sat below the clip.
// The field caps itself on --composer-max-h and wears data-composer-field;
// the modal sets the cap as a share of its fixed height, and the dock, which
// grows with the draft up to the viewport, measures what its max leaves.
const composeView = readFileSync(join(import.meta.dir, "..", "..", "components", "ComposeView.tsx"), "utf8");

test("the composer textarea caps its height on --composer-max-h and scrolls past it", () => {
  const textareaClass = source.match(/style=\{FIELD_SIZING_STYLE\}\s+className=\{`([^`]+)`\}/)?.[1]?.split(/\s+/) ?? [];
  expect(textareaClass).toContain("max-h-[var(--composer-max-h,45vh)]");
  expect(textareaClass).toContain("overflow-y-auto");
  expect(textareaClass).not.toContain("overflow-hidden");
  expect(source).toMatch(/data-chat-input\s+data-composer-field/);
});

test("the expanded editor box is bound by the same cap and is the field in that mode", () => {
  expect(source).toContain('composeMode ? "min-h-[min(40vh,var(--composer-max-h,40vh))] max-h-[var(--composer-max-h,45vh)]"');
  expect(source).toContain('data-composer-field={composeMode ? "" : undefined}');
});

test("the modal is a fixed frame that hands the field a share of its height", () => {
  expect(composeView).toContain("[--frame-h:min(88vh,680px)] h-[var(--frame-h)] [--composer-max-h:calc(var(--frame-h)*0.45)]");
});

test("the dock grows to the viewport and measures the cap from what its max leaves", () => {
  expect(composeView).toContain("[--frame-h:calc(100vh-5rem)] max-h-[var(--frame-h)]");
  expect(composeView).toContain('root.querySelector<HTMLElement>("[data-composer-field]")');
  expect(composeView).toContain('root.style.setProperty("--composer-max-h"');
});

// A field must paint exactly the characters it holds. JetBrains Mono's
// contextual alternates draw ?? and !! as a spacer plus a pair glyph, and
// Chrome's keystroke-by-keystroke reshaping of a textarea left the spacers
// without the pair: "?????" typed by key painted as three blanks and two
// marks while the value held all five. Ligatures stay off in every editable
// surface, app wide, so no composer or input can regress into it.
const globalsCss = readFileSync(join(import.meta.dir, "..", "..", "app", "globals.css"), "utf8");

test("editable fields render without ligatures", () => {
  expect(globalsCss).toMatch(/input,\s*textarea,\s*\[contenteditable="true"\]\s*\{\s*font-variant-ligatures:\s*none;\s*\}/);
});
