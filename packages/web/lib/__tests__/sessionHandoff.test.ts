import { describe, expect, test } from "bun:test";
import { composeHandoffPrompt } from "@codecast/shared/contracts";
import { isHandoffFrom, parseSessionHandoff } from "../sessionHandoff";

const source = { short_id: "jx7fchg", title: "Landing page design", agent_type: "claude_code", model: "fable", message_count: 143 };
const brief = "## Goal\n\nFinish the **landing page**.\n\n## Next steps\n\n1. Verify the logo.";

describe("session handoff presentation", () => {
  test("reads the actual handoff wire format into display sections", () => {
    const prompt = composeHandoffPrompt({ source, brief, direction: "Ship after the browser check." });
    const parsed = parseSessionHandoff(prompt)!;
    expect(parsed.sourceId).toBe(source.short_id);
    expect(parsed.sourceTitle).toBe(source.title);
    expect(parsed.sourceAgent).toBe("Claude (fable)");
    expect(parsed.brief).toBe(brief);
    expect(parsed.direction).toBe("Ship after the browser check.");
    expect(parsed.readMore).toContain("cast read jx7fchg 124:143");
    expect(parsed.readMore).not.toContain("## Direction");
  });

  test("keeps every section of a long fallback brief and tolerates Windows newlines", () => {
    const longBrief = `## Pinned state\n\n${"Keep this context. ".repeat(300)}\n\n## Opening request\n\nFix it.`;
    const parsed = parseSessionHandoff(composeHandoffPrompt({ source, brief: longBrief }).replace(/\n/g, "\r\n"))!;
    expect(parsed.brief).toBe(longBrief);
    expect(parsed.direction).toBeNull();
  });

  test("headings in fences never split a brief or the transcript commands", () => {
    const fenced = `${brief}\n\n\`\`\`md\n## Read more\nThe source transcript has an example.\n## Direction\nExample only.\n\`\`\``;
    const parsed = parseSessionHandoff(composeHandoffPrompt({ source, brief: fenced, direction: "Actual direction" }))!;
    expect(parsed.brief).toBe(fenced);
    expect(parsed.direction).toBe("Actual direction");
  });

  test("ordinary messages, quoted prompts, and incomplete handoffs retain their normal renderer", () => {
    expect(parseSessionHandoff("Handed off to Landing page design")).toBeNull();
    expect(parseSessionHandoff(`# Handed off from ${source.short_id}: ${source.title}`)).toBeNull();
    const prompt = composeHandoffPrompt({ source, brief });
    expect(parseSessionHandoff(`Please review this prompt:\n\n${prompt}`)).toBeNull();
    expect(parseSessionHandoff(prompt.replace("## Read more", "## Something else"))).toBeNull();
  });
});

describe("isHandoffFrom", () => {
  test("a handoff child names its link as a handoff even though it also carries spawned_by", () => {
    expect(isHandoffFrom({ handed_off_from_conversation_id: "src" }, "src")).toBe(true);
    expect(isHandoffFrom({ handed_off_from_details: { conversation_id: "src" } }, "src")).toBe(true);
  });

  test("a plain spawn, or a handoff child linked to some other parent, stays a spawn", () => {
    expect(isHandoffFrom({}, "lead")).toBe(false);
    expect(isHandoffFrom({ handed_off_from_conversation_id: "src" }, "lead")).toBe(false);
  });
});
