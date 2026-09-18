import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUBBLE_PRESETS, DEFAULT_BUBBLE_PRESET, isCustomBubbleColor, resolveBubbleHue } from "../bubbleColor";

const ROOT = join(import.meta.dir, "..", "..");
const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
const panel = readFileSync(join(ROOT, "components", "GlobalSessionPanel.tsx"), "utf8");
const diffView = readFileSync(join(ROOT, "components", "DiffView.tsx"), "utf8");
const terminalSessions = readFileSync(join(ROOT, "lib", "terminal", "termSessions.ts"), "utf8");
const conversationView = readFileSync(join(ROOT, "components", "ConversationView.tsx"), "utf8");

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
    expect(css).toMatch(/\[data-sv-title\] \{[\s\S]*?font-size: 15px;/);
    expect(css).toMatch(/\[data-sv-prompt\] \{[\s\S]*?font-size: 12\.5px;/);
    expect(css).toMatch(/\[data-sv-sec\] \{[\s\S]*?font-size: 12px;/);
  });

  test("paints your bubble, in the feed and pinned, from the one color you chose", () => {
    // Both bubbles read the same variable, and the stylesheet's fallback hue is
    // the default preset, so a root with no inline hue still paints the default.
    expect(css.match(/background: var\(--cc-user-bubble\) !important;/g)).toHaveLength(2);
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

  test("rests the header on its title: only marked controls stay visible", () => {
    expect(css).toContain("[data-cc-conv-actions] > :not([data-cc-keep])");
    expect(conversationView).toContain("<button data-cc-keep aria-label=\"Session menu\"");
    // The name row of the pinned bubble is hidden by its own hook. A class
    // match here once hid the dismiss and expand buttons along with it.
    expect(css).not.toMatch(/\[data-sv-sticky\] > \.flex\.items-center/);
    expect(css).toContain("[data-sv-sticky-who]");
  });
});
