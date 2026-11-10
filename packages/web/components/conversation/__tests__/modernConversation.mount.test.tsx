import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import type { ReactElement } from "react";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

// The Modern style's conversation: one row anatomy for tool, `cast` and system
// rows (a 16px icon, a verb, the object, the result at the right, a chevron
// from aria-expanded), the header as one line, and whole images. Classic and
// Minimal draw the same markup as before, which the classic cases pin.

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
});
afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const { renderToStaticMarkup } = await import("react-dom/server");
const { MemoryRouter } = await import("react-router");
const { ConvexProvider } = await import("convex/react");
const { ThemeContext } = await import("../../ThemeProvider");
const { offlineConvexClient } = await import("../../../test-helpers/offlineConvex");
const { ToolBlock } = await import("../blocks/toolBlocks");
const { CastCommandBlock } = await import("../blocks/castBlocks");
const { SystemBlock } = await import("../blocks/systemBlocks");
const { ImageBlock } = await import("../blocks/interactiveBlocks");
const { AgentStatusPill, ConversationHeaderBar, ConversationHeaderTitle } = await import("../ConversationHeaderBar");
const { ComposerSendButton, ComposerShell, ComposerTextarea, ComposerTextRow } = await import("../../ComposerShell");
const { modernToolHead, failureLine, toolRowKind } = await import("../../../lib/modernRow");
const { imageBoxStyle, knownImageDims, rememberImageDims } = await import("../../../lib/imageDims");

const client = offlineConvexClient();
type Style = "classic" | "modern";

function draw(el: ReactElement, style: Style): HTMLElement {
  const html = renderToStaticMarkup(
    <ConvexProvider client={client}>
      <MemoryRouter>
        <ThemeContext.Provider value={{ theme: "light", toggleTheme: () => {}, visualStyle: style, setVisualStyle: () => {} }}>
          {el}
        </ThemeContext.Provider>
      </MemoryRouter>
    </ConvexProvider>,
  );
  const host = dom.window.document.createElement("div");
  host.innerHTML = html;
  return host;
}

const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? null;

/** A selector list split on its own commas, not the ones inside :is(…). */
function topLevelSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

let n = 0;
function tool(name: string, input: unknown, result?: { content: string; is_error?: boolean }) {
  const id = `modern-tool-${n++}`;
  return {
    tool: { id, name, input: JSON.stringify(input) },
    result: result ? { tool_use_id: id, ...result } : undefined,
  };
}

const read = tool("Read", { file_path: "src/server.ts" }, { content: "     1\timport { listen } from './net';\n     2\tlisten(3000);" });
const failedEdit = tool("Edit", { file_path: "src/server.ts", old_string: "a", new_string: "b" }, { content: "<tool_use_error>String to replace not found in file.</tool_use_error>", is_error: true });
const pendingBash = tool("Bash", { command: "bun test" });

describe("Modern rows", () => {
  test("a Read row reads as an icon, a verb, its path in mono and the result at the right", () => {
    const row = draw(<ToolBlock tool={read.tool} result={read.result} />, "modern").querySelector('[data-cc-row="tool"]')!;
    const head = row.querySelector("[data-cc-row-head]")!;
    expect(head.querySelector("svg[data-cc-row-icon]")).not.toBeNull();
    expect(text(head.querySelector("[data-cc-row-verb]"))).toBe("Read");
    expect(text(head.querySelector("[data-cc-row-object]"))).toContain("server.ts");
    expect(head.querySelector("[data-cc-row-object]")!.className).toContain("font-mono");
    expect(text(head.querySelector("[data-cc-row-meta]"))).toBe("2 lines");
    // The chevron is drawn from aria-expanded (globals.css "MODERN · ROWS").
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  test("a failed edit turns red and says what failed", () => {
    const row = draw(<ToolBlock tool={failedEdit.tool} result={failedEdit.result} />, "modern").querySelector('[data-cc-row="tool"]')!;
    expect(row.getAttribute("data-cc-row-tone")).toBe("error");
    expect(text(row.querySelector("[data-cc-row-verb]"))).toBe("Edit failed");
    expect(text(row.querySelector("[data-cc-row-meta]"))).toBe("String to replace not found in file.");
  });

  test("a call with no result names the act and claims nothing live", () => {
    const row = draw(<ToolBlock tool={pendingBash.tool} />, "modern").querySelector('[data-cc-row="tool"]')!;
    expect(text(row.querySelector("[data-cc-row-verb]"))).toBe("Run");
    expect(text(row.querySelector("[data-cc-row-object]"))).toBe("bun test");
    expect(row.querySelector("[data-cc-row-meta]")).toBeNull();
  });

  test("Classic draws the rows it drew before: the tool's name, the result in parens, no icon", () => {
    const readRow = draw(<ToolBlock tool={read.tool} result={read.result} />, "classic");
    expect(text(readRow.querySelector("[data-cc-row-verb]"))).toBe("Read");
    expect(text(readRow.querySelector("[data-cc-row-meta]"))).toBe("(2 lines)");
    expect(readRow.querySelector("[data-cc-row-icon]")).toBeNull();
    const editRow = draw(<ToolBlock tool={failedEdit.tool} result={failedEdit.result} />, "classic");
    expect(text(editRow.querySelector("[data-cc-row-verb]"))).toBe("Edit");
    expect(text(editRow.querySelector("[data-cc-row-meta]"))).toBe("(error)");
    expect(editRow.querySelector("[data-cc-row-meta]")!.hasAttribute("title")).toBe(false);
    const bashRow = draw(<ToolBlock tool={pendingBash.tool} />, "classic");
    expect(text(bashRow.querySelector("[data-cc-row-verb]"))).toBe("Bash");
  });

  test("a cast command and a system notice wear the same parts", () => {
    const ls = tool("Bash", { command: "cast task ls" }, { content: "ct-1 one\nct-2 two\nct-3 three" });
    const cast = draw(<CastCommandBlock tool={ls.tool} result={ls.result} />, "modern").querySelector('[data-cc-row="cast"]')!;
    const head = cast.querySelector("[data-cc-row-head]")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(text(head.querySelector("[data-cc-row-verb]"))).toBe("task ls");
    expect(head.querySelector("[data-cc-row-lead] > svg")).not.toBeNull();
    // The parens are Classic's; Modern hides them with modern:hidden.
    const meta = head.querySelector("[data-cc-row-meta]")!;
    expect(text(meta)).toBe("(3 items)");
    expect(meta.querySelectorAll(".modern\\:hidden")).toHaveLength(2);

    const notice = draw(<SystemBlock subtype="informational" content="Hook ran in 2s" />, "modern").querySelector('[data-cc-row="system"]')!;
    expect(notice.hasAttribute("data-cc-row-head")).toBe(true);
    expect(text(notice.querySelector("[data-cc-row-verb]"))).toBe("informational");
    // Its icon exists in every style and shows only in Modern.
    expect(notice.querySelector("svg[data-cc-row-icon]")!.getAttribute("class")).toContain("hidden modern:block");
  });
});

describe("Modern header", () => {
  test("one line: the title, the facts as text, the live status as the pill", () => {
    const header = draw(
      <ConversationHeaderBar
        title={<ConversationHeaderTitle text="Retry failed webhooks" />}
        status={<AgentStatusPill agentStatus="working" />}
        facts={<><span>Claude · Opus</span><span>main</span></>}
        actions={<button aria-label="Session menu" />}
      />,
      "modern",
    );
    const row = header.querySelector(".cq-squeeze-row")!;
    expect(text(row.querySelector("[data-cc-conv-title]"))).toBe("Retry failed webhooks");
    expect(row.querySelector("[data-cc-facts]")!.children).toHaveLength(2);
    expect(row.querySelector("[data-cc-conv-status]")).not.toBeNull();
    expect(row.querySelector("[data-cc-conv-actions] button")).not.toBeNull();
    expect(row.className).toContain("overflow-hidden");
  });

  test("the stylesheet sets the title, the pills and the 28px actions, and never wraps the row", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "..", "app", "globals.css"), "utf8");
    const start = css.lastIndexOf("/*", css.indexOf("MODERN · THE CONVERSATION"));
    const modern = css.slice(start, css.indexOf("end of MODERN · THE CONVERSATION"));
    expect(start).toBeGreaterThan(0);
    expect(modern).toMatch(/\.modern-style \[data-sv-convhead\] \.cc-panel__title \{[^}]*font-size: var\(--fs-read\);[^}]*font-weight: 600;/);
    expect(modern).toMatch(/\.modern-style \[data-sv-convhead\] \[data-cc-conv-status\] \{[^}]*border-radius: 9999px;/);
    expect(modern).toMatch(/\[data-cc-conv-actions\] > :is\(button, a\) \{[^}]*min-height: 28px;/);
    expect(modern).not.toMatch(/cq-squeeze-row[^{]*\{[^}]*flex-wrap:\s*wrap/);
    // Every Modern rule is scoped to the style.
    for (const rule of modern.replace(/\/\*[\s\S]*?(\*\/|$)/g, "").matchAll(/([^{}@]+)\{[^{}]*\}/g)) {
      for (const sel of topLevelSelectors(rule[1])) expect(sel).toStartWith(".modern-style");
    }
  });
});

describe("Modern composer", () => {
  test("the docked composer names its parts, so Modern can lay out the field's footer and the status line under it", () => {
    const shell = draw(
      <ComposerShell meta="Working · 2:13" metaEnd={<button data-session-control-trigger="composer">Opus</button>}>
        <ComposerTextRow send={<ComposerSendButton canSubmit={false} />}>
          <ComposerTextarea value="" readOnly placeholder="Send a message..." />
        </ComposerTextRow>
      </ComposerShell>,
      "modern",
    );
    expect(shell.querySelector('[data-cc-composer-frame="dock"]')).not.toBeNull();
    const stack = shell.querySelector('[data-cc-composer-stack="dock"]')!;
    expect(stack.querySelector("[data-cc-composer-meta] [data-cc-composer-controls] [data-session-control-trigger]")).not.toBeNull();
    expect(stack.querySelector('form [data-cc-composer-box="dock"] [data-cc-composer-send] [data-cc-send]')).not.toBeNull();
    // Send is the filled accent disc in Modern, dimmed until there is text.
    const send = stack.querySelector("[data-cc-send]")!;
    expect(send.className).toContain("modern:bg-sol-cyan");
    expect(send.className).toContain("modern:opacity-35");
  });

  test("a bare, inline or hero composer is not the docked one", () => {
    for (const [props, variant] of [[{ bare: true }, "bare"], [{ inline: true }, "inline"], [{ hero: true }, "hero"]] as const) {
      const shell = draw(<ComposerShell {...props}><span /></ComposerShell>, "modern");
      expect(shell.querySelector("[data-cc-composer-box]")!.getAttribute("data-cc-composer-box")).toBe(variant);
    }
  });
});

describe("Modern images", () => {
  const image = { media_type: "image/png", data: "iVBORw0KGgo=" };

  test("an image of known size reserves its own box, capped at 28rem tall", () => {
    const box = draw(<ImageBlock image={{ ...image, width: 1600, height: 900 }} />, "modern").querySelector("[data-cc-image]") as HTMLElement;
    expect(box.getAttribute("data-cc-image")).toBe("sized");
    expect(box.style.aspectRatio).toBe("1600 / 900");
    expect(box.getAttribute("style")).toContain("min(100%, 1600px, 49.7778rem)");
  });

  test("an image of unknown size keeps the 100px box only while it loads", () => {
    const box = draw(<ImageBlock image={image} />, "modern").querySelector("[data-cc-image]") as HTMLElement;
    expect(box.getAttribute("data-cc-image")).toBe("unknown");
    expect(box.style.height).toBe("100px");
  });

  test("Classic keeps its 100px strip", () => {
    const strip = draw(<ImageBlock image={{ ...image, width: 1600, height: 900 }} />, "classic");
    expect(strip.querySelector("[data-cc-image]")).toBeNull();
    expect(strip.querySelector('[style*="height:100px"]')).not.toBeNull();
  });

  test("a decoded size is remembered for the next mount of the same src", () => {
    expect(knownImageDims({}, "blob:one")).toBeNull();
    rememberImageDims("blob:one", { width: 400, height: 1200 });
    expect(knownImageDims({}, "blob:one")).toEqual({ width: 400, height: 1200 });
    expect(knownImageDims({ width: 10, height: 20 }, "blob:one")).toEqual({ width: 10, height: 20 });
    expect(imageBoxStyle({ width: 400, height: 1200 })).toEqual({ width: "min(100%, 400px, 9.3333rem)", aspectRatio: "400 / 1200" });
  });
});

describe("Modern row words", () => {
  test("verbs follow the call: done, not yet answered, failed", () => {
    const head = (name: string, result?: { content: string; is_error?: boolean }, resultSummary: string | null = null) =>
      modernToolHead({ name, displayName: name, result, resultSummary });
    expect(head("Edit", { content: "ok" }, "(+3 -1)")).toEqual({ kind: "edit", verb: "Edited", meta: "+3 −1", failed: false });
    expect(head("Grep", { content: "a\nb" }, "(2 matches)").verb).toBe("Searched");
    expect(head("Write").verb).toBe("Write");
    expect(head("Bash", { content: "boom", is_error: true }).verb).toBe("Command failed");
    expect(head("mcp__paper__get_basic_info", { content: "{}" }).verb).toBe("mcp__paper__get_basic_info");
    expect(toolRowKind("apply_patch")).toBe("edit");
    expect(toolRowKind("mcp__claude-in-chrome__navigate")).toBe("browser");
    expect(failureLine("\n<tool_use_error>File does not exist.</tool_use_error>\nmore")).toBe("File does not exist.");
  });

  test("the transcript's height cache keys Modern apart, so a style switch never reuses heights", () => {
    const view = readFileSync(join(import.meta.dir, "..", "..", "ConversationView.tsx"), "utf8");
    expect(view).toContain('${modernStyle ? ":m" : ""}');
    expect(view).toMatch(/\[feedDensity, foldWorkingTurns, foldTurns, timeline, turnAggregates, expandedGroups, modernStyle\]/);
  });

  test("the files-changed chip sits in the header row, never floating over the feed", () => {
    const layout = readFileSync(join(import.meta.dir, "..", "..", "ConversationDiffLayout.tsx"), "utf8");
    const pill = layout.match(/className="cc-changes-pill[^"]*"/)?.[0] ?? "";
    expect(pill).toContain("flex-shrink-0");
    expect(pill).not.toMatch(/\babsolute\b/);
    expect(layout).not.toContain("--conv-sticky-h");
  });
});
