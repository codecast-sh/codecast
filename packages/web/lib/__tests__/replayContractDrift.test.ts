import { describe, expect, test } from "bun:test";
import * as platform from "@platform/analytics/replay";
import type { CodecastIngestItem } from "@platform/analytics/codecast";
import * as shared from "@codecast/shared/contracts/replay";
import type { IngestItem } from "@codecast/shared/contracts/ingest";

// @platform/analytics may not import codecast, so its recorder spells the
// replay event types and the ingest item types itself. This holds the two
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
});
