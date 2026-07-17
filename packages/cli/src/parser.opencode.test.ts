import { describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parseOpencodeSessionFile, parseTranscriptFor } from "./parser";

// Fixtures are `opencode export --sanitize` output of FRESH synthetic sessions I
// created in throwaway dirs (a one-word reply, and a trivial `cat` tool use). The
// --sanitize pass replaces every content field — text, reasoning, tool
// input/output/metadata/title, session directory/title — with a `[redacted:…]`
// token, so nothing originates from real history while the real structure (part
// types, tool state shape, message/part ordering) is preserved. The export shape is
// exactly what assembleOpencodeSession reconstructs from the DB, so these also pin
// the format the parser must handle.
const FIX = path.join(__dirname, "__fixtures__", "opencode");
const toolsExport = fs.readFileSync(path.join(FIX, "session-tools.sanitized.json"), "utf-8");
const textExport = fs.readFileSync(path.join(FIX, "session-text.sanitized.json"), "utf-8");
// Fully SYNTHETIC session (hand-written to opencode's export shape, /tmp path,
// fabricated base64 that decodes to "SYNTHETIC-FAKE-IMAGE-DATA") — pins that a
// `file` part carrying a base64 data URL maps to ParsedMessage.images.
const imageExport = fs.readFileSync(path.join(FIX, "session-image.sanitized.json"), "utf-8");

describe("parseOpencodeSessionFile", () => {
  it("maps a real tool-using session (user + tool turn + text turn) to ParsedMessages", () => {
    const msgs = parseOpencodeSessionFile(toolsExport);
    expect(msgs.length).toBe(3);
    const [user, toolTurn, textTurn] = msgs;

    expect(user.role).toBe("user");
    // content flows through as the sanitized token (proves text-part -> content).
    expect(user.content.startsWith("[redacted:text:")).toBe(true);

    // Assistant turn that ran a bash tool: one call + its completed result, paired by id.
    expect(toolTurn.role).toBe("assistant");
    expect(toolTurn.toolCalls?.length).toBe(1);
    expect(toolTurn.toolCalls?.[0].name).toBe("bash");
    expect(typeof toolTurn.toolCalls?.[0].input).toBe("object");
    expect(toolTurn.toolResults?.length).toBe(1);
    expect(toolTurn.toolResults?.[0].toolUseId).toBe(toolTurn.toolCalls?.[0].id);
    // reasoning part folds into thinking.
    expect((toolTurn.thinking ?? "").length).toBeGreaterThan(0);

    // Final assistant text turn carries prose content + the model it ran on.
    expect(textTurn.role).toBe("assistant");
    expect(textTurn.content.startsWith("[redacted:text:")).toBe(true);
    expect(textTurn.model).toBe("big-pickle");
  });

  it("parses a text-only session (reasoning folds to thinking, no tools)", () => {
    const msgs = parseOpencodeSessionFile(textExport);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const assistant = msgs[1];
    expect(assistant.toolCalls).toBeUndefined();
    expect(assistant.content.length).toBeGreaterThan(0);
    expect(assistant.model).toBe("big-pickle");
  });

  it("maps a `file` part (base64 data URL) to ParsedMessage.images", () => {
    const msgs = parseOpencodeSessionFile(imageExport);
    expect(msgs.length).toBe(1);
    const [user] = msgs;
    expect(user.role).toBe("user");
    expect(user.content).toBe("look at this screenshot");
    expect(user.images?.length).toBe(1);
    expect(user.images?.[0].mediaType).toBe("image/png");
    // the base64 payload rides through verbatim (data URL prefix stripped).
    expect(user.images?.[0].data).toBe("U1lOVEhFVElDLUZBS0UtSU1BR0UtREFUQQ==");
  });

  it("routes through parseTranscriptFor('opencode')", () => {
    expect(parseTranscriptFor("opencode", toolsExport)).toEqual(parseOpencodeSessionFile(toolsExport));
  });

  it("returns [] for malformed or empty input", () => {
    expect(parseOpencodeSessionFile("not json")).toEqual([]);
    expect(parseOpencodeSessionFile(JSON.stringify({ info: {}, messages: [] }))).toEqual([]);
    expect(parseOpencodeSessionFile(JSON.stringify({}))).toEqual([]);
  });
});
