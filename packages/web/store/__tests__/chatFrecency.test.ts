import { describe, expect, it } from "bun:test";
import { chatFrecency } from "../chatFrecency";
import type { ChatMessageRow } from "../chatSlice";

describe("chatFrecency", () => {
  const now = Date.UTC(2026, 9, 6);
  const day = 86_400_000;
  const msg = (channel_id: string, ageDays: number, i: number) =>
    [`m${channel_id}${i}`, { _id: `m${channel_id}${i}`, channel_id, created_at: now - ageDays * day } as ChatMessageRow] as const;

  it("ranks a room talked in daily above one with a single newer line", () => {
    const messages = Object.fromEntries([
      ...[1, 2, 3, 4, 5, 6].map((d, i) => msg("busy", d, i)),
      msg("quiet", 0.1, 0),
    ]);
    const f = chatFrecency([{ id: "busy", sortAt: now - day }, { id: "quiet", sortAt: now - 0.1 * day }], messages, now);
    expect(f.get("busy")!).toBeGreaterThan(f.get("quiet")!);
  });

  it("ranks by the newest line when no history is loaded", () => {
    const f = chatFrecency([{ id: "old", sortAt: now - 20 * day }, { id: "new", sortAt: now - day }], {}, now);
    expect(f.get("new")!).toBeGreaterThan(f.get("old")!);
  });
});
