import { describe, expect, test } from "bun:test";
import { ControlModeParser, toSendKeysHex, unescapeControlData, type ControlEvent } from "./controlProtocol.js";

function collect(parser: ControlModeParser, input: string | Buffer): ControlEvent[] {
  const events: ControlEvent[] = [];
  parser.feed(input, (ev) => events.push(ev));
  return events;
}

describe("unescapeControlData", () => {
  test("passes plain ASCII through", () => {
    expect(unescapeControlData("hello").toString()).toBe("hello");
  });

  test("decodes octal escapes to bytes", () => {
    expect(unescapeControlData("a\\015\\012b")).toEqual(Buffer.from("a\r\nb"));
    expect(unescapeControlData("\\033[1;34m")).toEqual(Buffer.from("\x1b[1;34m"));
  });

  test("decodes escaped backslash (\\134)", () => {
    expect(unescapeControlData("C:\\134path").toString()).toBe("C:\\path");
  });

  test("reassembles UTF-8 multibyte sequences escaped per byte", () => {
    // é = 0xC3 0xA9 = \303\251
    expect(unescapeControlData("caf\\303\\251").toString("utf8")).toBe("café");
  });

  test("preserves unescaped Unicode and the ANSI sequences following it", () => {
    for (const text of ["▐▛███▜▌", "─".repeat(80), "╭─╮ café 🚀", "日本語 e\u0301"]) {
      expect(unescapeControlData(`${text}\\033[0m`)).toEqual(Buffer.from(`${text}\x1b[0m`));
    }
  });

  test("preserves raw UTF-8 bytes mixed with octal escapes", () => {
    const input = Buffer.concat([Buffer.from("▐\\033[2m"), Buffer.from([0xf0, 0x9f])]);
    expect(unescapeControlData(input)).toEqual(Buffer.concat([Buffer.from("▐\x1b[2m"), Buffer.from([0xf0, 0x9f])]));
  });

  test("leaves non-octal backslash sequences alone", () => {
    expect(unescapeControlData("a\\9b").toString()).toBe("a\\9b");
  });

  test("handles trailing backslash without escape", () => {
    expect(unescapeControlData("abc\\").toString()).toBe("abc\\");
  });
});

describe("toSendKeysHex", () => {
  test("hex-encodes bytes with padding", () => {
    expect(toSendKeysHex(Buffer.from([0x0d, 0x7f, 0x01]))).toEqual(["0x0d", "0x7f", "0x01"]);
  });
});

describe("ControlModeParser", () => {
  test("emits output events with unescaped data", () => {
    const events = collect(new ControlModeParser(), "%output %5 echo\\015\\012\n");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "output", paneId: "%5" });
    expect((events[0] as any).data).toEqual(Buffer.from("echo\r\n"));
  });

  test("frames reply blocks and treats %-lines inside them as content", () => {
    const parser = new ControlModeParser();
    const events = collect(
      parser,
      "%begin 100 1 1\nline one\n%output-looking content\n%end 100 1 1\n",
    );
    expect(events).toEqual([{ type: "reply", ok: true, lines: ["line one", "%output-looking content"] }]);
  });

  test("marks %error blocks as failed replies", () => {
    const events = collect(new ControlModeParser(), "%begin 1 2 1\nbad target\n%error 1 2 1\n");
    expect(events).toEqual([{ type: "reply", ok: false, lines: ["bad target"] }]);
  });

  test("handles chunks split mid-line and mid-escape", () => {
    const parser = new ControlModeParser();
    const events: ControlEvent[] = [];
    const emit = (ev: ControlEvent) => events.push(ev);
    parser.feed("%output %1 ab\\0", emit);
    parser.feed("15cd\n%exi", emit);
    parser.feed("t\n", emit);
    expect(events[0]).toMatchObject({ type: "output", paneId: "%1" });
    expect((events[0] as any).data).toEqual(Buffer.from("ab\rcd"));
    expect(events[1]).toEqual({ type: "exit", reason: undefined });
  });

  test("does not split UTF-8 characters across chunk boundaries in reply blocks", () => {
    const parser = new ControlModeParser();
    const events: ControlEvent[] = [];
    const bytes = Buffer.from("%begin 1 1 1\ncafé line\n%end 1 1 1\n", "utf8");
    // Split inside the two-byte é sequence.
    const splitAt = bytes.indexOf(0xc3) + 1;
    parser.feed(bytes.subarray(0, splitAt), (ev) => events.push(ev));
    parser.feed(bytes.subarray(splitAt), (ev) => events.push(ev));
    expect(events).toEqual([{ type: "reply", ok: true, lines: ["café line"] }]);
  });

  test("preserves Unicode output at every transport chunk boundary", () => {
    for (const prefix of ["%output %5 ", "%extended-output %5 0 : "]) {
      const output = Buffer.from("▐▛███▜▌ ── café 🚀\x1b[0m");
      const protocol = Buffer.from(`${prefix}▐▛███▜▌ ── café 🚀\\033[0m\n`);
      for (let at = 1; at < protocol.length; at++) {
        const parser = new ControlModeParser();
        const events: ControlEvent[] = [];
        parser.feed(protocol.subarray(0, at), (ev) => events.push(ev));
        parser.feed(protocol.subarray(at), (ev) => events.push(ev));
        expect(events).toEqual([{ type: "output", paneId: "%5", data: output }]);
      }
    }
  });

  test("preserves UTF-8 sequences split between output messages", () => {
    const output = Buffer.from("▐▛███▜▌ ── café 🚀\x1b[0m");
    for (let at = 1; at < output.length; at++) {
      const parser = new ControlModeParser();
      const events: ControlEvent[] = [];
      const protocol = Buffer.concat([
        Buffer.from("%output %5 "), output.subarray(0, at), Buffer.from("\n%extended-output %5 0 : "),
        output.subarray(at), Buffer.from("\n"),
      ]);
      for (const byte of protocol) parser.feed(Buffer.from([byte]), (ev) => events.push(ev));
      expect(Buffer.concat(events.flatMap((ev) => ev.type === "output" ? [ev.data] : []))).toEqual(output);
    }
  });

  test("parses exit with reason, pause and continue", () => {
    const parser = new ControlModeParser();
    const events = collect(parser, "%pause %3\n%continue %3\n%exit detached\n");
    expect(events).toEqual([
      { type: "pause", paneId: "%3" },
      { type: "continue", paneId: "%3" },
      { type: "exit", reason: "detached" },
    ]);
  });

  test("emits generic notifications", () => {
    const events = collect(new ControlModeParser(), "%window-renamed @1 zsh\n");
    expect(events).toEqual([{ type: "notification", name: "window-renamed", rest: "@1 zsh" }]);
  });

  test("strips CR line endings", () => {
    const events = collect(new ControlModeParser(), "%output %1 hi\r\n");
    expect((events[0] as any).data).toEqual(Buffer.from("hi"));
  });

  test("parses extended-output data after the colon separator", () => {
    const events = collect(new ControlModeParser(), "%extended-output %2 0 : data\\015\n");
    expect(events[0]).toMatchObject({ type: "output", paneId: "%2" });
    expect((events[0] as any).data).toEqual(Buffer.from("data\r"));
  });
});
