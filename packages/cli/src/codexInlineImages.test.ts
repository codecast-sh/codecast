import { describe, expect, test } from "bun:test";
import { threadItemToMessage, threadItemsToMessages } from "./codexAppServer.js";
import { inlineImageMarker } from "./inlineImage.js";
import { parseCodexSessionFile } from "./parser.js";

const paths = ["/tmp/browser shots/page.png", "/tmp/browser shots/failed.png"];
const output = `page captured\n${inlineImageMarker(paths[0])}\n${inlineImageMarker(paths[0])}\nclick failed\n${inlineImageMarker(paths[1])}`;
const images = paths.map(localPath => ({ mediaType: "image/png", localPath, toolUseId: "shot" }));
const command = (aggregatedOutput: string, status = "completed") => ({
  type: "commandExecution" as const, id: "shot", command: "cast browser shot", cwd: "/tmp", status, aggregatedOutput,
});

describe("Codex browser screenshot markers", () => {
  test.each(["completed", "failed"])("extracts screenshots from %s commands and progress rebuilds", status => {
    const item = command(output, status);
    const single = threadItemToMessage(item, 123)!;
    const grouped = threadItemsToMessages([item]);
    expect(single.uuid).toBe("shot");
    expect(single.timestamp).toBe(123);
    expect(single.images).toEqual(images);
    expect(single.toolResults).toEqual([{
      toolUseId: "shot", content: "page captured\n\nclick failed", isError: status === "failed",
    }]);
    expect(grouped[0].images).toEqual(single.images);
    expect(grouped[0].toolResults).toEqual(single.toolResults);
    expect(threadItemsToMessages([item, command("later output")])[0].images).toEqual(images);
  });

  for (const type of ["function_call_output", "custom_tool_call_output"]) {
    test.each([false, true])(`extracts ${type} screenshot markers with content blocks = %s`, blocks => {
      const messages = parseCodexSessionFile(JSON.stringify({
        type: "response_item", timestamp: "2026-09-21T14:32:00Z",
        payload: {
          type, call_id: "shot",
          output: blocks ? [
            { type: "output_text", text: output },
            { type: "input_image", image_url: "data:image/jpeg;base64,AAAA" },
          ] : output,
        },
      }));
      expect(messages).toHaveLength(1);
      expect(messages[0].images).toEqual(blocks
        ? [{ mediaType: "image/jpeg", data: "AAAA", toolUseId: "shot" }, ...images]
        : images);
      expect(messages[0].toolResults?.[0].content).toBe("page captured\n\nclick failed");
    });
  }

  test("leaves ordinary output and quoted or incomplete markers unchanged", () => {
    for (const text of ["ordinary output\n\n\n", `quoted ${inlineImageMarker(paths[0])}`, "⁢cast:image /tmp/incomplete.png"]) {
      const message = threadItemToMessage(command(text))!;
      expect(message.images).toBeUndefined();
      expect(message.toolResults?.[0].content).toBe(text);
      const parsed = parseCodexSessionFile(JSON.stringify({
        type: "response_item", timestamp: "2026-09-21T14:32:00Z",
        payload: { type: "function_call_output", call_id: "shot", output: text },
      }))[0];
      expect(parsed.images).toBeUndefined();
      expect(parsed.toolResults?.[0].content).toBe(text);
    }
  });

  test("does not extract local paths from user or assistant prose", () => {
    for (const role of ["user", "assistant"]) {
      const messages = parseCodexSessionFile(JSON.stringify({
        type: "response_item", timestamp: "2026-09-21T14:32:00Z",
        payload: { type: "message", role, content: [{ type: "input_text", text: output }] },
      }));
      expect(messages[0].images).toBeUndefined();
      expect(messages[0].content).toContain("cast:image");
    }
  });
});
