import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxSession } from "../../../store/inboxStore";
import type { TaskRow } from "../../triggerTasks";
import { killReviewOf } from "../killReview";
import { assertGlance } from "./glance";

// One Kill, one rule: the card menu, a selection and the palette all ask
// this before killing, and end at once only when nothing is lost.
const s = (id: string, extra: Partial<InboxSession> = {}) => ({ _id: id, title: `Row ${id}`, is_idle: true, has_pending: false, ...extra }) as InboxSession;
const armed = (id: string, conv: string) => ({ _id: id, title: `Check ${id}`, prompt: "p", status: "scheduled", schedule_type: "once", originating_conversation_id: conv }) as TaskRow;

describe("killReviewOf", () => {
  test("an idle session with nothing armed or queued ends at once", () => {
    expect(killReviewOf([s("a")], [armed("t", "other")])).toBeNull();
  });

  test("an armed trigger asks first and names it", () => {
    const l = killReviewOf([s("a")], [armed("t", "a")])!;
    expect(l.name).toBe("Kill session");
    expect(l.subject).toBe("Row a");
    expect(l.rows.find((r) => r.k === "Triggers")).toMatchObject({ v: "1 trigger canceled", list: ["Check t"] });
    assertGlance(l);
  });

  test("a persistent anchor keeps its triggers and queue on a kill, so only a cut-off turn asks", () => {
    expect(killReviewOf([s("a", { persistent: true, has_pending: true })], [armed("t", "a")])).toBeNull();
    expect(killReviewOf([s("a", { persistent: true, is_idle: false })], [])?.rows.find((r) => r.k === "Working")?.list).toEqual(["Row a"]);
  });

  test("a role's own session never asks here: its kill opens the retire question instead", () => {
    expect(killReviewOf([s("a", { standing_role_id: "r1", is_idle: false, has_pending: true })], [armed("t", "a")])).toBeNull();
    const l = killReviewOf([s("a", { standing_role_id: "r1" }), s("b", { has_pending: true }), s("c")], [armed("t", "a")])!;
    expect(l.name).toBe("Kill 2 sessions");
    // Nothing armed to cancel: no Triggers row at all, rather than a bare "Canceled".
    expect(l.rows.find((r) => r.k === "Triggers")).toBeUndefined();
  });

  test("queued messages ask first", () => {
    const l = killReviewOf([s("a", { has_pending: true })], [])!;
    expect(l.rows.find((r) => r.k === "Queued")?.v).toBe("Messages dropped");
    assertGlance(l);
  });

  test("the palette's Kill and the menu's Kill both ask through it", () => {
    const read = (rel: string) => readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");
    const palette = read("CommandPalette.tsx");
    const branch = palette.slice(palette.indexOf('actionKey === "session_kill"'), palette.indexOf("killManyWithNotice(ids);", palette.indexOf('actionKey === "session_kill"')));
    expect(branch).toContain("killReviewOf(");
    expect(read("BulkMoveSessions.tsx")).toContain("killReviewOf(");
  });

  test("a session mid-turn asks first, for a selection too", () => {
    const l = killReviewOf([s("a", { is_idle: false }), s("b")], [])!;
    expect(l.name).toBe("Kill 2 sessions");
    expect(l.rows.find((r) => r.k === "Working")?.list).toEqual(["Row a"]);
    assertGlance(l);
  });
});
