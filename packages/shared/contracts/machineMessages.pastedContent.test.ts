import { describe, expect, test } from "bun:test";
import { isMachineDeliveredMessage, isPollResponsePayload, isSessionMessage, parseUserMessage, stripInjectionNoise, stripPastedContent } from "./machineMessages";

const paste = (body: string) => `<pasted_content id="a83d">\n${body}\n</pasted_content id="a83d">`;

describe("pasted content", () => {
  test("removes both wrapper forms without changing the body", () => {
    const body = "## Report\n\n- **Ready**\n\n    indented code\n\n";
    expect(stripPastedContent(paste(body))).toBe(body);
    expect(stripPastedContent(`<pasted_content>\r\n${body}\r\n</pasted_content>`)).toBe(body);
    expect(stripPastedContent(body)).toBe(body);
  });

  test("retains surrounding text, adjacent fragments, and nested bodies", () => {
    expect(stripPastedContent(`Before\n${paste("First")}\nBetween\n${paste("Second")}\nAfter`))
      .toBe("Before\nFirst\nBetween\nSecond\nAfter");
    expect(stripPastedContent(paste("hel") + paste("lo"))).toBe("hello");
    expect(stripPastedContent(paste(paste("Nested")))).toBe("Nested");
  });

  test("strips framing from truncated previews", () => {
    expect(stripPastedContent('<pasted_content id="a83d">\nPreview')).toBe("Preview");
    expect(stripPastedContent('Preview\n</pasted_content id="a8')).toBe("Preview");
    expect(stripPastedContent('<pasted_content id="a8')).toBe("");
  });

  test("leaves unrelated XML and similarly named tags alone", () => {
    const body = '<pasted_content_example>Example</pasted_content_example>\n<widget value="x">Body</widget>';
    expect(stripPastedContent(paste(body))).toBe(body);
  });

  test("detects the sender through paste and injection framing", () => {
    const body = '<session-message from="jx774ye">\nThe rule already holds.\n</session-message>';
    const raw = `\n\n${paste(`\u0001<system-reminder>Noise</system-reminder>\nh${body}`)}\n`;
    expect(stripInjectionNoise(raw).trim()).toBe(body);
    expect(isSessionMessage(raw)).toBe(true);
    expect(isMachineDeliveredMessage(raw)).toBe(true);
    expect(isSessionMessage(paste(body).slice(0, 80))).toBe(true);
  });

  test.each([
    '<agent-message from="reviewer">Ready</agent-message>',
    '<scheduled-task title="Check">Run the check</scheduled-task>',
    '<task-notification>Finished</task-notification>',
    '<teammate-message teammate_id="reviewer">Ready</teammate-message>',
  ])("classifies the underlying machine message: %s", (body) => {
    expect(isMachineDeliveredMessage(paste(body))).toBe(true);
  });

  test("keeps human pastes human and parses their original format", () => {
    expect(isMachineDeliveredMessage(paste("Please fix this"))).toBe(false);
    const direct = paste('<user-message from="Ada">\nPlease fix this\n</user-message>');
    expect(isMachineDeliveredMessage(direct)).toBe(false);
    expect(parseUserMessage(direct)).toEqual({ from: "Ada", body: "Please fix this" });
    expect(isPollResponsePayload(paste('{"__cc_poll":true}'))).toBe(true);
  });
});
