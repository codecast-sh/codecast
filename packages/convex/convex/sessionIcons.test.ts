import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { SESSION_ICON_RETRY_MS, performRequestSessionIcon } from "./sessionIcons";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";

const wrench = ROLE_ICON_EXAMPLES.find((e) => e.icon.concept === "wrench")!.icon;

describe("performRequestSessionIcon", () => {
  const conv = (extra: any = {}) => ({ _id: "conversations_a", user_id: "users_me", is_private: true, title: "Fix the login redirect", ...extra });
  const setup = (c: any) => {
    const db = makeFakeDb({ conversations: [c] });
    const scheduled: any[] = [];
    return { db, scheduled, ctx: { db, scheduler: { runAfter: async (_ms: number, _fn: any, args: any) => { scheduled.push(args); } } } as any };
  };

  test("schedules one drawing for a titled session, then holds off until the retry window passes", async () => {
    const { db, scheduled, ctx } = setup(conv());
    expect(await performRequestSessionIcon(ctx, "users_me" as any, "conversations_a", 1_000)).toBe(true);
    expect(scheduled).toEqual([{ conversation_id: "conversations_a", user_id: "users_me" }]);
    expect((await db.get("conversations_a")).drawn_icon_requested_at).toBe(1_000);
    expect(await performRequestSessionIcon(ctx, "users_me" as any, "conversations_a", 2_000)).toBe(false);
    expect(await performRequestSessionIcon(ctx, "users_me" as any, "conversations_a", 1_000 + SESSION_ICON_RETRY_MS)).toBe(true);
  });

  test("draws nothing for an untitled session, one already drawn, or someone who cannot see it", async () => {
    expect(await performRequestSessionIcon(setup(conv({ title: "  " })).ctx, "users_me" as any, "conversations_a")).toBe(false);
    expect(await performRequestSessionIcon(setup(conv({ drawn_icon: wrench })).ctx, "users_me" as any, "conversations_a")).toBe(false);
    expect(await performRequestSessionIcon(setup(conv()).ctx, "users_other" as any, "conversations_a")).toBe(false);
  });
});
