import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const css = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
const panel = readFileSync(join(ROOT, "components", "GlobalSessionPanel.tsx"), "utf8");
const diffView = readFileSync(join(ROOT, "components", "DiffView.tsx"), "utf8");
const terminalSessions = readFileSync(join(ROOT, "lib", "terminal", "termSessions.ts"), "utf8");

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
    expect(css).toContain("background: color-mix(in srgb, var(--sol-blue) 7%, var(--sol-bg)) !important;");
  });
});
