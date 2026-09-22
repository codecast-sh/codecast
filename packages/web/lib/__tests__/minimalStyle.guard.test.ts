import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUBBLE_PRESETS, DEFAULT_BUBBLE_PRESET, isCustomBubbleColor, resolveBubbleHue } from "../bubbleColor";

const ROOT = join(import.meta.dir, "..", "..");
const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
const panel = readFileSync(join(ROOT, "components", "GlobalSessionPanel.tsx"), "utf8");
const diffView = readFileSync(join(ROOT, "components", "DiffView.tsx"), "utf8");
const terminalSessions = readFileSync(join(ROOT, "lib", "terminal", "termSessions.ts"), "utf8");
// The conversation surface: the container plus every module it was split into.
const conversationDir = join(ROOT, "components", "conversation");
const conversationView = [
  join(ROOT, "components", "ConversationView.tsx"),
  join(ROOT, "components", "MessageInput.tsx"),
  ...(readdirSync(conversationDir, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test."))
    .map((file) => join(conversationDir, file)),
]
  .map((file) => readFileSync(file, "utf8"))
  .join("\n");

describe("Minimal interface style", () => {
  test("keeps semantic monospace content in JetBrains Mono", () => {
    expect(css).not.toMatch(/\.minimal-style\s+\.font-mono\s*\{/);
    expect(css).toMatch(/\.minimal-style code,[\s\S]*?font-family: var\(--font-mono\)/);
    expect(diffView).toContain("code-block-resizable group font-mono");
    expect(terminalSessions).toContain('fontFamily: \'"JetBrains Mono"');
  });

  test("distinguishes the active session without status row fills", () => {
    expect(panel.match(/data-active=\{isActive \? "true" : undefined\}/g)).toHaveLength(2);
    expect(css).toContain('[data-session-id]:not([data-active="true"])[class*="border-l-sol-cyan"]');
    expect(css).toContain('[data-session-id][data-active="true"]');
  });

  test("marks the rail controls for the Minimal treatment", () => {
    expect(panel).toContain("data-sv-controls");
    expect(css).toContain("[data-sv-rail] [data-sv-controls]");
  });

  test("keeps the composer compact and conversation text readable", () => {
    expect(css).toMatch(/\[data-sv-composer\] form:not\(\.w-full\) > div \{[\s\S]*?min-height: 52px;[\s\S]*?padding: 9px 12px 8px;/);
    // One scale: the list scans at --t-ui, its second lines at --t-sub.
    expect(css).toMatch(/--t-ui: 13px;/);
    expect(css).toMatch(/\.minimal-style \[data-sv-rail\] \[data-sv-title\] \{[\s\S]*?font-size: var\(--t-ui\);/);
    expect(css).toMatch(/\.minimal-style \[data-sv-rail\] \[data-sv-sec\] \{[\s\S]*?font-size: var\(--t-sub\);/);
  });

  test("paints your bubble, in the feed and pinned, from the one color you chose", () => {
    // Both bubbles read the same variable, and the stylesheet's fallback hue is
    // the default preset, so a root with no inline hue still paints the default.
    expect(css.match(/background(?:-color)?: var\(--cc-user-bubble\) !important;/g)).toHaveLength(2);
    const fallback = css.match(/--cc-user-bubble-hue: (#[0-9a-f]{6});/)?.[1];
    expect(fallback).toBe(resolveBubbleHue(undefined));
    expect(resolveBubbleHue(DEFAULT_BUBBLE_PRESET)).toBe(fallback!);
  });

  test("never lets a stored color reach the stylesheet unchecked", () => {
    expect(resolveBubbleHue("#A1B2C3")).toBe("#a1b2c3");
    expect(resolveBubbleHue("green")).toBe(BUBBLE_PRESETS.find((p) => p.id === "green")!.hue);
    for (const bad of ["red; background: url(x)", "#fff", "#12345g", "no-such-preset", ""]) {
      expect(resolveBubbleHue(bad)).toBe(resolveBubbleHue(undefined));
    }
    expect(isCustomBubbleColor("#a1b2c3")).toBe(true);
    expect(isCustomBubbleColor("green")).toBe(false);
  });

  test("keeps every Minimal rule on the one type scale", () => {
    // Four sizes, three weights. A rule that needs another value is a rule that
    // breaks the hierarchy the rest of the style is built on.
    const sizes = new Set(["15px", "13px", "12px", "11px"]);
    const weights = new Set(["400", "500", "600"]);
    const off: string[] = [];
    for (const rule of css.matchAll(/(\.minimal-style[^{}]*)\{([^}]*)\}/g)) {
      for (const [, prop, raw] of rule[2].matchAll(/(font-size|font-weight):\s*([^;]+);/g)) {
        const value = raw.trim();
        const ok = value.startsWith("var(--t-") || (prop === "font-size" ? sizes : weights).has(value);
        if (!ok) off.push(`${prop}: ${value} in ${rule[1].trim().slice(0, 80)}`);
      }
    }
    expect(off).toEqual([]);
  });

  test("speaks plain words: technical details and the strips under the header are tucked away", () => {
    expect(css).toContain(".minimal-style [data-cc-conversation] [data-cc-tech],");
    expect(css).toContain("[data-cc-conversation]:not([data-cc-context]) [data-cc-context-panel]");
    // A job that did not complete keeps its line: only the completed echo goes.
    expect(css).toContain('[data-cc-feed-card][data-status="completed"]');
    expect(css).not.toMatch(/\[data-status="(failed|killed|timeout)"\][^{]*\{[^}]*display: none/);
    // The shell line, the ids and the counts carry the marker; the way back is in the menu.
    expect(conversationView.match(/data-cc-tech/g)!.length).toBeGreaterThanOrEqual(12);
    expect(conversationView).toContain('"Show schedule and plan"');
  });

  test("rests the header on its title: only marked controls stay visible", () => {
    expect(css).toContain("[data-cc-conv-actions] > :not([data-cc-keep])");
    // Hidden, not faded: nothing in Minimal appears on hover.
    expect(css).not.toMatch(/\.minimal-style[^{]*:hover[^{]*\{[^}]*opacity: 1/);
    expect(conversationView).toContain("<button data-cc-keep aria-label=\"Session menu\"");
    // The name row of the pinned bubble is hidden by its own hook. A class
    // match here once hid the dismiss and expand buttons along with it.
    expect(css).not.toMatch(/\[data-sv-sticky\] > \.flex\.items-center/);
    expect(css).toContain("[data-sv-sticky-who]");
  });
});
