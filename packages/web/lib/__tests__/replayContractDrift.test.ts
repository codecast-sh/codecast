import { describe, expect, test } from "bun:test";
import * as platform from "@platform/analytics/replay";
import { CODECAST_BATCH_LIMITS, isReportedLogLevel, type CodecastIngestItem } from "@platform/analytics/codecast";
import * as shared from "@codecast/shared/contracts/replay";
import * as player from "@codecast/shared/contracts/replayPlayer";
import { parseCodecastJson, REPLAY_DOM_MODES as PLATFORM_DOM_MODES } from "@platform/analytics/codecast";
import { parseCodecastConfig, REPLAY_DOM_MODES } from "@codecast/shared/contracts/codecastConfig";
import codecastJson from "../../codecast.json";
import { INGEST_LIMITS, isGroupedLogLevel, LOG_LEVELS, type IngestItem } from "@codecast/shared/contracts/ingest";

// @platform/analytics may not import codecast, so its recorder and sink spell
// the replay event types, the ingest item types, the batch caps and the
// grouped log levels themselves. This holds the two
// spellings to each other: the type lines fail `cast check web`, the
// assertions fail the test.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameEvents: Same<platform.ReplayEvent, shared.ReplayEvent> = true;
const sameItems: Same<CodecastIngestItem, IngestItem> = true;

describe("the platform recorder speaks codecast's replay contract", () => {
  test("event types, keys, console levels and limits match", () => {
    expect(sameEvents && sameItems).toBe(true);
    expect([...platform.REPLAY_KEYS]).toEqual([...shared.REPLAY_KEYS]);
    expect([...platform.REPLAY_CONSOLE_LEVELS]).toEqual([...shared.REPLAY_CONSOLE_LEVELS]);
    expect(platform.REPLAY_LIMITS).toEqual(shared.REPLAY_LIMITS);
  });

  test("the DOM capture's caps and modes match, and both read a codecast.json's replay block alike", () => {
    expect(platform.REPLAY_DOM_LIMITS).toEqual(player.REPLAY_DOM_LIMITS);
    expect([...PLATFORM_DOM_MODES]).toEqual([...REPLAY_DOM_MODES]);
    const files: unknown[] = [
      codecastJson,
      { sources: {}, replay: { dom: "sampled", sampleRate: 0.25 } },
      { sources: {}, replay: { dom: "always", sampleRate: 2, extra: 1 } },
      { sources: {}, replay: "on" },
    ];
    for (const file of files) expect(parseCodecastJson(file)).toEqual(parseCodecastConfig(file) as never);
  });

  test("codecast web ships with DOM capture off", () => {
    const parsed = parseCodecastConfig(codecastJson);
    expect(parsed.ok && (parsed.config.replay?.dom ?? "off")).toBe("off");
  });

  test("both clean a URL the same way, so an imported replay keeps no more than a recorded one", () => {
    const urls: [string, string?][] = [
      ["https://a.test/x?token=abc&page=2#frag"],
      ["https://a.test/reset?email=a%40b.co"],
      ["/api/me?key=v#h", "https://a.test/app"],
      ["https://a.test/plain"],
      ["not a url?secret=1"],
      [`https://a.test/${"p".repeat(3000)}?k=v`],
    ];
    for (const [raw, base] of urls) expect(shared.cleanUrl(raw, base)).toBe(platform.cleanUrl(raw, base));
  });
});

describe("the platform sink speaks codecast's ingest contract", () => {
  test("batch caps and the log levels it reports match the door", () => {
    expect(CODECAST_BATCH_LIMITS).toEqual({ max_items: INGEST_LIMITS.max_items, max_bytes: INGEST_LIMITS.max_bytes });
    expect(LOG_LEVELS.filter(isReportedLogLevel)).toEqual(LOG_LEVELS.filter(isGroupedLogLevel));
  });
});
