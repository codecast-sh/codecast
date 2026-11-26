import { describe, expect, test } from "bun:test";
import { meetingLinkIn, parseMeetingUrl } from "./meetingLinks";

describe("meetingLinkIn", () => {
  test("a pasted meeting link is offered a bot, with its platform's name", () => {
    expect(meetingLinkIn("https://us02web.zoom.us/j/81234567890?pwd=x")).toMatchObject({ platform: "zoom", name: "Zoom" });
    expect(meetingLinkIn("meet.google.com/abc-defg-hij")).toMatchObject({ url: "https://meet.google.com/abc-defg-hij", name: "Google Meet" });
    expect(meetingLinkIn("  https://teams.microsoft.com/l/meetup-join/19%3a  ")?.platform).toBe("microsoft_teams");
  });

  test("a name being typed, a bare platform host or another site is not", () => {
    expect(meetingLinkIn("ana")).toBeNull();
    expect(meetingLinkIn("zoom.us")).toBeNull();
    expect(meetingLinkIn("https://zoom.us/")).toBeNull();
    expect(meetingLinkIn("https://example.com/j/1")).toBeNull();
    expect(meetingLinkIn("meet with ana")).toBeNull();
  });

  test("the server's rule is the same one", () => {
    expect(parseMeetingUrl("https://meet.google.com/").ok).toBe(false);
  });
});
