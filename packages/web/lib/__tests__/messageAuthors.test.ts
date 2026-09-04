import { describe, expect, test } from "bun:test";
import { formatAgentSwitchNotice } from "@codecast/shared/contracts";
import { messageAgentTypes, sameMessageAuthor } from "../messageAuthors";

const reply = (id: string, timestamp: number, model?: string) => ({ _id: id, role: "assistant", content: id, timestamp, model });
const change = (id: string, timestamp: number, fromAgent: string, toAgent: string) => ({
  _id: id, role: "user", timestamp, content: formatAgentSwitchNotice({ fromAgent, toAgent }),
});

describe("historical message authors", () => {
  test("keeps old Claude replies attributed after switching to Codex", () => {
    const messages = [reply("old", 1, "claude-opus-4-8"), reply("tool", 2), change("switch", 3, "claude_code", "codex"), reply("new", 4, "gpt-5.6-sol")];
    const authors = messageAgentTypes(messages, "codex");
    expect(authors.get("old")).toBe("claude_code");
    expect(authors.get("tool")).toBe("claude_code");
    expect(authors.get("new")).toBe("codex");
    expect(messages[0].model).toBe("claude-opus-4-8");
    expect(messages[1].model).toBeUndefined();
  });

  test("preserves each segment through repeated and reverse switches", () => {
    const messages = [reply("a", 1), change("s1", 2, "claude_code", "codex"), reply("b", 3), change("s2", 4, "codex", "gemini"), reply("c", 5), change("s3", 6, "gemini", "claude_code"), reply("d", 7)];
    const authors = messageAgentTypes(messages, "claude_code");
    expect(["a", "b", "c", "d"].map(id => authors.get(id))).toEqual(["claude_code", "codex", "gemini", "claude_code"]);
  });

  test("uses the recorded client even when two clients run the same model", () => {
    const messages = [reply("a", 1, "claude-opus-4-8"), change("s", 2, "opencode", "pi"), reply("b", 3, "claude-opus-4-8")];
    const authors = messageAgentTypes(messages, "pi");
    expect(authors.get("a")).toBe("opencode");
    expect(authors.get("b")).toBe("pi");
    expect(sameMessageAuthor(messages[0], messages[2], authors)).toBe(false);
  });

  test("uses message model evidence when a paged window has no switch notice", () => {
    const authors = messageAgentTypes([reply("a", 1, "claude-fable-5"), reply("b", 2, "gpt-6-astra")], "codex");
    expect(authors.get("a")).toBe("claude_code");
    expect(authors.get("b")).toBe("codex");
  });

  test("does not mistake a model provider for a multi-provider agent", () => {
    for (const agent of ["cursor", "opencode", "pi"]) {
      const authors = messageAgentTypes([reply("a", 1, "claude-opus-4-8"), reply("b", 2, "gpt-5.5")], agent);
      expect(authors.get("a")).toBe(agent);
      expect(authors.get("b")).toBe(agent);
    }
  });

  test("is independent of an optimistic change to the current agent", () => {
    const messages = [reply("a", 1), change("s", 2, "claude_code", "codex"), reply("b", 3)];
    expect(messageAgentTypes(messages, "gemini")).toEqual(messageAgentTypes(messages, "codex"));
  });

  test("handles unsorted rows and model labels on notices", () => {
    const notice = { _id: "s", role: "user", timestamp: 2, content: formatAgentSwitchNotice({ fromAgent: "claude_code", fromModel: "fable", toAgent: "codex", toModel: "gpt-5.6-sol" }) };
    const authors = messageAgentTypes([reply("new", 3), reply("old", 1), notice], "codex");
    expect(authors.get("old")).toBe("claude_code");
    expect(authors.get("new")).toBe("codex");
  });

  test("does not interpret an assistant quoting a notice as a switch", () => {
    const quote = { ...change("quote", 2, "claude_code", "codex"), role: "assistant" };
    expect(messageAgentTypes([reply("a", 1), quote, reply("b", 3)], "claude_code").get("b")).toBe("claude_code");
  });

  test("does not invent an author before a legacy notice without a previous agent", () => {
    const notice = { _id: "s", role: "user", timestamp: 3, content: formatAgentSwitchNotice({ toAgent: "codex" }) };
    const authors = messageAgentTypes([reply("unknown", 1), reply("known", 2, "claude-sonnet-5"), notice, reply("new", 4)], "codex");
    expect(authors.get("unknown")).toBeUndefined();
    expect(authors.get("known")).toBe("claude_code");
    expect(authors.get("new")).toBe("codex");
  });

  test("starts a new author group on a model change", () => {
    const messages = [reply("a", 1, "gpt-5.5"), reply("b", 2, "gpt-6-astra"), reply("c", 3, "gpt-6-astra")];
    const authors = messageAgentTypes(messages, "codex");
    expect(sameMessageAuthor(messages[0], messages[1], authors)).toBe(false);
    expect(sameMessageAuthor(messages[1], messages[2], authors)).toBe(true);
  });
});
