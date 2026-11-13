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
const { modernToolHead, failureLine, toolRowKind, modernGroupHead } = await import("../../../lib/modernRow");
const { AgentWorkingBubble, AssistantBlock } = await import("../blocks/turnBlocks");
const { AskUserQuestionBlock, MonitorBlock, PlanModeBlock, ThinkingBlock } = await import("../blocks/interactiveBlocks");
const { StructuredResultBlock } = await import("../blocks/toolBlocks");
const { ReviveDivider, SessionMessageBlock } = await import("../blocks/systemBlocks");
const { ApiErrorCard } = await import("../sessionChrome");
const { PermissionStackView } = await import("../../PermissionCard");
const { ModernDecisionDock } = await import("../ModernDecisionDock");
const { DELIVERY_FAILED_SUBTYPE, formatDeliveryFailedNotice } = await import("@codecast/shared/contracts/deliveryFailed");
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
    // Live pills (the status among them) share one round 22px shape.
    expect(modern).toMatch(/\.modern-style \[data-sv-convhead\] :is\(\[data-cc-conv-status\][^)]*\) \{[^}]*height: 22px;[^}]*border-radius: 9999px;/);
    expect(modern).toMatch(/\[data-cc-conv-actions\] > :is\(button, a\)[^{]*\{[^}]*min-height: 28px;/);
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

// ── The second pass: the families that were still in Classic shape ──────────

const bash = (command: string, content: string, is_error = false) => tool("Bash", { command }, { content, is_error });
const noop = () => {};

function receipt(calls: ReturnType<typeof tool>[], style: Style, expanded = false) {
  const results = calls.map((c) => c.result!);
  return draw(
    <AssistantBlock
      content="Counted the files."
      timestamp={1}
      messageId="m-receipt"
      toolCalls={calls.map((c) => c.tool)}
      toolResults={results}
      density="condensed"
      condensedReceipt={{ entries: [{ messageId: "m-receipt", timestamp: 1, tools: calls.map((c) => c.tool) }], expanded, onToggle: noop }}
    />,
    style,
  );
}

describe("Modern folded runs of tool calls", () => {
  const wc = bash("wc -l src/*.ts", "  12 src/a.ts\n  30 src/b.ts\n  42 total");
  const runs = [wc, bash("grep -rn listen src", "src/a.ts:2:listen(3000)"), bash("git status --short", " M src/a.ts")];

  test("a run of commands is one flat row: an icon, the count by kind, the commands in mono, a chevron", () => {
    const row = receipt(runs, "modern").querySelector('[data-cc-row="group"]')!;
    const head = row.querySelector("[data-cc-row-head]")!;
    expect(head.hasAttribute("data-cc-tool-receipt")).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.querySelector("svg[data-cc-row-icon]")).not.toBeNull();
    expect(text(head.querySelector("[data-cc-row-verb]"))).toBe("ran 3 commands");
    expect(text(head.querySelector("[data-cc-row-object]"))).toBe("wc · grep · git status");
  });

  test("one command reads as its own row would, its whole command in mono and its result at the right", () => {
    const head = receipt([wc], "modern").querySelector('[data-cc-row="group"] [data-cc-row-head]')!;
    expect(text(head.querySelector("[data-cc-row-verb]"))).toBe("Ran");
    expect(text(head.querySelector("[data-cc-row-object]"))).toBe("wc -l src/*.ts");
    expect(text(head.querySelector("[data-cc-row-meta]"))).toBe("3 lines");
  });

  test("open, the calls are rows under it, with no rule beside them", () => {
    const row = receipt(runs, "modern", true).querySelector('[data-cc-row="group"]')!;
    expect(row.querySelectorAll("[data-cc-row-list] [data-cc-row-head]").length).toBeGreaterThanOrEqual(3);
  });

  test("Classic keeps its dashed receipt chip with the phrase", () => {
    const host = receipt([wc], "classic");
    const head = host.querySelector("[data-cc-tool-receipt]")!;
    expect(head.hasAttribute("data-cc-row-head")).toBe(false);
    expect(host.querySelector('[data-cc-row="group"]')).toBeNull();
    expect(head.className).toContain("border-dashed");
    expect(text(head)).toBe("ran wc");
  });

  test("the words of a run: shared kind or a mixed glyph, failures counted", () => {
    const resultOf = (c: { name: string; input: string }) => runs.concat([wc]).find((r) => r.tool.input === c.input)?.result;
    expect(modernGroupHead(runs.map((r) => r.tool), "ran 3 commands", resultOf)).toMatchObject({ kind: "shell", meta: null, failed: 0 });
    const mixed = [read.tool, wc.tool];
    expect(modernGroupHead(mixed, "read 1 file · ran 1 command", () => undefined)).toMatchObject({ kind: "group", object: "server.ts · wc", meta: "2 calls" });
    const failing = bash("bun test", "1 fail", true);
    expect(modernGroupHead([wc.tool, failing.tool], "ran 2 commands", (c) => (c.input === failing.tool.input ? failing.result : undefined)).meta).toBe("1 failed");
  });
});

describe("Modern rows for things that happened", () => {
  test("thinking is one quiet row that opens to the whole of it", () => {
    const row = draw(<ThinkingBlock content={"Weighing grid against cards.\nFour columns will not fit a phone."} />, "modern").querySelector('[data-cc-row="thinking"]')!;
    expect(text(row.querySelector("[data-cc-row-verb]"))).toBe("Thought");
    expect(text(row.querySelector("[data-cc-row-text]"))).toBe("Weighing grid against cards.");
    expect(row.querySelector("[data-cc-row-head]")!.getAttribute("aria-expanded")).toBe("false");
    expect(draw(<ThinkingBlock content="a\nb\nc" />, "classic").querySelector("[data-cc-row]")).toBeNull();
  });

  test("a watch is a row whose status is a word, never a pulse", () => {
    const watch = tool("Monitor", { command: "tail -f build.log", description: "Build log" });
    const row = draw(<MonitorBlock tool={watch.tool} />, "modern").querySelector('[data-cc-row="monitor"]')!;
    expect(text(row.querySelector("[data-cc-row-verb]"))).toBe("Monitor");
    expect(text(row.querySelector("[data-cc-row-text]"))).toBe("Build log");
    expect(text(row.querySelector("[data-cc-row-meta]"))).toBe("watching");
    expect(row.querySelector(".animate-pulse")).toBeNull();
    expect(draw(<MonitorBlock tool={watch.tool} />, "classic").querySelector("[data-cc-monitor-card]")).not.toBeNull();
  });

  test("entering plan mode is a row; Classic keeps its pill", () => {
    const enter = tool("EnterPlanMode", {}, { content: "Entered plan mode" });
    expect(text(draw(<PlanModeBlock tool={enter.tool} result={enter.result} />, "modern").querySelector('[data-cc-row="plan-mode"] [data-cc-row-verb]'))).toBe("Entered plan mode");
    expect(text(draw(<PlanModeBlock tool={enter.tool} result={enter.result} />, "classic"))).toContain("Plan Mode");
  });

  test("a switch, a revive or an escalation is a row with its notice behind the chevron", () => {
    const row = draw(<ReviveDivider content={"The agent exited.\nResume where you left off."} timestamp={1} />, "modern").querySelector('[data-cc-row="divider"]')!;
    const head = row.querySelector("[data-cc-row-head]")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(text(head.querySelector("[data-cc-row-verb]"))).toBe("restarted after the agent process exited");
    expect(head.querySelectorAll("[data-cc-divider] > [data-cc-row-rule]")).toHaveLength(2);
  });

  test("an undelivered message is a failure row with its put-back action on the row", () => {
    const content = formatDeliveryFailedNotice({ writes: 3, submitted: false, message: "Rebase on main." });
    const row = draw(<SystemBlock subtype={DELIVERY_FAILED_SUBTYPE} content={content} conversationId={"c1" as any} />, "modern").querySelector('[data-cc-row="error"]')!;
    expect(row.getAttribute("data-cc-row-tone")).toBe("error");
    expect(text(row.querySelector("[data-cc-row-verb]"))).toBe("Not delivered");
    expect(text(row.querySelector("[data-cc-row-actions] button"))).toBe("Send again");
    expect(draw(<SystemBlock subtype={DELIVERY_FAILED_SUBTYPE} content={content} conversationId={"c1" as any} />, "classic").querySelector("[data-cc-row]")).toBeNull();
  });
});

describe("Modern blocks a person reads", () => {
  const result = tool("StructuredOutput", { verdict: "NEEDS_CHANGES", findings: [{ severity: "major", file: "src/a.ts", issue: "Charges twice." }] }, { content: "Structured output provided successfully" });

  test("a structured result is a quiet block: the verdict at the right of its header, the findings on the panel", () => {
    const block = draw(<StructuredResultBlock tool={result.tool} result={result.result} />, "modern").querySelector('[data-cc-row="result"]')!;
    expect(block.hasAttribute("data-structured-result")).toBe(true);
    const head = block.querySelector("[data-cc-row-head]")!;
    expect(text(head.querySelector("[data-cc-row-verb]"))).toBe("Result");
    expect(text(head.querySelector("[data-cc-row-meta]"))).toBe("NEEDS CHANGES");
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(text(block.querySelector("[data-cc-row-detail]"))).toContain("Charges twice.");
    expect(text(block.querySelector("[data-cc-row-detail] button"))).toBe("JSON");
  });

  test("a rejected result is a red row; Classic keeps its card", () => {
    const rejected = tool("StructuredOutput", { verdict: "maybe" }, { content: "Output does not match required schema", is_error: true });
    const block = draw(<StructuredResultBlock tool={rejected.tool} result={rejected.result} />, "modern").querySelector('[data-cc-row="result"]')!;
    expect(block.getAttribute("data-cc-row-tone")).toBe("error");
    expect(text(block.querySelector("[data-cc-row-verb]"))).toBe("Result rejected");
    const classic = draw(<StructuredResultBlock tool={result.tool} result={result.result} />, "classic").querySelector("[data-structured-result]")!;
    expect(classic.hasAttribute("data-cc-row")).toBe(false);
    expect(classic.className).toContain("rounded-lg");
  });

  test("a plan is a quiet block headed Plan with its title; Classic keeps its card", () => {
    const plan = "# Retry failed webhooks\n\n1. Queue them.";
    const block = draw(<SystemBlock subtype="plan" content={plan} timestamp={1} />, "modern").querySelector('[data-cc-row="plan"]')!;
    expect(text(block.querySelector("[data-cc-row-verb]"))).toBe("Plan");
    expect(text(block.querySelector("[data-cc-row-text]"))).toBe("Retry failed webhooks");
    expect(block.querySelector("[data-cc-row-detail] [data-cc-prose]")).not.toBeNull();
    expect(draw(<SystemBlock subtype="plan" content={plan} timestamp={1} />, "classic").querySelector("[data-cc-row]")).toBeNull();
  });

  test("a message from another session is a header row over its body on the tinted panel", () => {
    const host = draw(<SessionMessageBlock from="unknown" name="iOS perf" body="Parser cost is **under 2ms**." timestamp={1} />, "modern");
    const row = host.querySelector('[data-cc-row="message"]')!;
    expect(text(row.querySelector("[data-cc-row-head] [data-cc-row-verb]"))).toBe("Message from");
    expect(text(row.querySelector("[data-cc-row-text]"))).toBe("iOS perf");
    expect(row.querySelector("[data-cc-prose]")!.closest("[class*='modern:bg-']")).not.toBeNull();
  });
});

describe("Modern asks: the one loud card", () => {
  const ask = tool("AskUserQuestion", { questions: [{ header: "410 Gone", question: "Should a 410 Gone count as a failed delivery?", options: [{ label: "Log it once (Recommended)", description: "Never retry" }, { label: "Retry like a 5xx", description: "Up to 5 attempts" }] }] });

  test("an open question is a card with the Needs you edge, the question at the reading size and Buttons", () => {
    const card = draw(<AskUserQuestionBlock tool={ask.tool} onSendMessage={noop} />, "modern").querySelector("[data-cc-ask]")!;
    expect(card.getAttribute("data-cc-ask")).toBe("needs_you");
    expect((card as HTMLElement).style.borderLeftColor).toBe("var(--sol-class-yellow)");
    expect(card.className).toContain("border-l-2");
    const question = card.querySelector("[data-cc-ask-question]")!;
    expect(text(question)).toBe("Should a 410 Gone count as a failed delivery?");
    expect(question.className).toContain("text-read");
    expect(question.className).toContain("font-semibold");
    const buttons = [...card.querySelectorAll("button.cc-btn")].map((b) => [text(b), b.className.includes("cc-btn-primary"), b.className.includes("modern:h-control-md")]);
    expect(buttons.slice(0, 2)).toEqual([["Log it once", true, true], ["Retry like a 5xx", false, true]]);
    expect(card.querySelector('input[aria-label="Answer in your own words"]')).not.toBeNull();
  });

  test("answered, it folds to one row that says what was chosen", () => {
    const row = draw(<AskUserQuestionBlock tool={ask.tool} result={{ tool_use_id: ask.tool.id, content: 'User has answered your questions: "Should a 410 Gone count as a failed delivery?"="Log it once". You can now continue.' }} />, "modern").querySelector('[data-cc-row="answered"]')!;
    expect(text(row.querySelector("[data-cc-row-verb]"))).toBe("Answered");
    expect(text(row.querySelector("[data-cc-row-meta]"))).toBe("Log it once");
  });

  test("a view that cannot answer reads the same card with its answers disabled", () => {
    const card = draw(<AskUserQuestionBlock tool={ask.tool} />, "modern").querySelector("[data-cc-ask]")!;
    expect([...card.querySelectorAll("button.cc-btn")].every((b) => b.hasAttribute("disabled"))).toBe(true);
    expect(card.querySelector("input")).toBeNull();
  });

  test("Classic keeps its violet card", () => {
    const host = draw(<AskUserQuestionBlock tool={ask.tool} onSendMessage={noop} />, "classic");
    expect(host.querySelector("[data-cc-ask]")).toBeNull();
    expect(host.querySelector(".border-sol-violet\\/30")).not.toBeNull();
  });

  test("a plan waiting on approval is the card with its three answers", () => {
    const exit = tool("ExitPlanMode", { plan: "# Ship it\n\n1. Do it." });
    const card = draw(<PlanModeBlock tool={exit.tool} onSendMessage={noop} />, "modern").querySelector("[data-cc-plan-approval]")!;
    expect([...card.querySelectorAll("button.cc-btn")].map((b) => text(b))).toEqual(["Start, clear context", "Start, keep context", "Request changes"]);
  });

  test("the docked permission prompt asks in words with 32px answers; Classic keeps its stack", () => {
    const pending = [{ _id: "p1", tool_name: "Bash", arguments_preview: "rm -rf dist", status: "pending" as const, intent: "Clean the build" }];
    const props = { pending, inflight: new Set<string>(), onApprove: noop, onDeny: noop, onApproveAll: noop, onDenyAll: noop };
    const card = draw(<PermissionStackView {...props} />, "modern").querySelector("[data-cc-ask]")!;
    expect(text(card.querySelector("[data-cc-ask-question]"))).toBe("Allow Bash?");
    const answers = [...card.querySelectorAll("button.cc-btn")];
    expect(answers.map((b) => text(b))).toEqual(["Approve", "Deny"]);
    expect(answers.every((b) => b.className.includes("modern:h-control-md"))).toBe(true);
    const classic = draw(<PermissionStackView {...props} />, "classic");
    expect(classic.querySelector("[data-cc-ask]")).toBeNull();
    expect(text(classic.querySelector("button"))).toBe("Approve");
  });

  test("a docked decision shows its question and options as Buttons, the default primary", () => {
    const card = draw(
      <ModernDecisionDock question="Ship the renderer behind a flag?" options={[{ label: "Ship now", index: 0 }, { label: "Flag it", index: 1 }]} recommended={1} held={() => false} onAnswer={noop} onAnswerText={noop} onOpen={noop} answerable />,
      "modern",
    ).querySelector("[data-cc-ask]")!;
    const options = [...card.querySelectorAll("[data-decision-options] button")];
    expect(options.map((b) => [text(b), b.className.includes("cc-btn-primary")])).toEqual([["Ship now", false], ["Flag it", true]]);
    expect(card.querySelector("[data-decision-open]")).not.toBeNull();
  });
});

describe("Modern failures, paths and the live line", () => {
  test("a dropped connection is one red row with Retry on it; resolved, it goes quiet", () => {
    const error = { message: "API Error: Connection closed mid-response.", isConnection: true };
    const row = draw(<ApiErrorCard error={error} conversationId="c-error" timestamp={1} />, "modern").querySelector('[data-cc-row="error"]')!;
    expect(row.getAttribute("data-cc-row-tone")).toBe("error");
    expect(text(row.querySelector("[data-cc-row-verb]"))).toBe("Connection dropped");
    expect(text(row.querySelector("[data-cc-row-actions] button"))).toBe("Retry");
    const classic = draw(<ApiErrorCard error={error} conversationId="c-error" timestamp={1} />, "classic");
    expect(classic.querySelector("[data-cc-row]")).toBeNull();
    expect(classic.querySelector(".rounded-lg")).not.toBeNull();
  });

  test("a path in a row keeps its file name: the directories shrink, the name does not", () => {
    const deep = tool("Read", { file_path: "/Users/me/src/codecast/packages/web/components/conversation/blocks/ModernRow.tsx" }, { content: "1\n2" });
    const path = draw(<ToolBlock tool={deep.tool} result={deep.result} />, "modern").querySelector("[data-cc-row-object] [data-cc-path]")!;
    expect(text(path.querySelector("[data-cc-path-dir]"))).toBe("codecast/packages/web/components/conversation/blocks/");
    expect(text(path.querySelector("[data-cc-path-base]"))).toBe("ModernRow.tsx");
    expect(path.querySelector("[data-cc-path-dir]")!.className).toContain("text-ellipsis");
    expect(path.querySelector("[data-cc-path-base]")!.className).toContain("shrink-0");
    // Modern draws the path bare, as it shipped.
    expect(path.className).not.toContain("[text-decoration:inherit]");
  });

  test("Classic and Minimal cut a row's path in the middle too, the link's dotted underline carried into it", () => {
    const deep = tool("Read", { file_path: "/Users/me/src/codecast/packages/web/components/conversation/blocks/ModernRow.tsx" }, { content: "1\n2" });
    const row = draw(<ToolBlock tool={deep.tool} result={deep.result} />, "classic");
    // Still Classic's row: the tool's name, the result in parens, no icon.
    expect(text(row.querySelector("[data-cc-row-verb]"))).toBe("Read");
    expect(row.querySelector("[data-cc-row-icon]")).toBeNull();
    const object = row.querySelector("[data-cc-row-object]")!;
    expect(object.className).toContain("truncate");
    const path = object.querySelector("a.fs-link [data-cc-path]")!;
    expect(text(path.querySelector("[data-cc-path-dir]"))).toBe("codecast/packages/web/components/conversation/blocks/");
    expect(text(path.querySelector("[data-cc-path-base]"))).toBe("ModernRow.tsx");
    expect(path.getAttribute("title")).toBe("codecast/packages/web/components/conversation/blocks/ModernRow.tsx");
    // An inline-flex box takes no underline from the link around it.
    expect(path.className).toContain("[text-decoration:inherit]");
    // The words are the same as before, only cut differently.
    expect(text(object)).toBe("codecast/packages/web/components/conversation/blocks/ModernRow.tsx");
  });

  test("the working bubble is the Working mark and word in Modern, three dots in Classic, and nothing moves", () => {
    const bubble = draw(<AgentWorkingBubble />, "modern").querySelector("[data-cc-working]")!;
    expect(bubble.querySelector("[data-cc-working-mark]")!.className).toContain("hidden modern:block");
    expect(bubble.querySelectorAll(".modern\\:hidden")).toHaveLength(3);
    expect(bubble.querySelector("[class*='animate-']")).toBeNull();
  });

  test("the stylesheet places the message actions under the message and adds no :has()", () => {
    const css = readFileSync(join(import.meta.dir, "..", "..", "..", "app", "globals.css"), "utf8");
    const modern = css.slice(css.indexOf("MODERN · THE CONVERSATION"), css.indexOf("end of MODERN · THE CONVERSATION"));
    expect(modern).toMatch(/\[data-cc-assistant-message-toolbar\], \[data-cc-user-message-toolbar\]\) \{[^}]*top: 100%;/);
    expect(modern).toMatch(/> button,\n\.modern-style \[data-sv-feed\] \[data-cc-message-action\] > span \{[^}]*width: 28px;[^}]*height: 28px;/);
    expect(modern).toMatch(/\[data-cc-row="group"\] > \[data-cc-row-head\] \{[^}]*flex: 1 1 auto;/);
    expect(modern).not.toContain(":has(");
  });
});
