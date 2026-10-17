import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { functionBlock } from "./test-helpers/sourceRegion";

// ct-56547: worker reports queued into finished Line stations retried every
// five minutes for days (retry 600+), because the delivery path gave up with a
// plain `false` even when the session could never resume and its conversation
// held nothing to rebuild it from. That case must cancel the row instead.
const source = fs.readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");

describe("delivery into a session that can never resume", () => {
  test("a repair that finds nothing resumable records the conversation", () => {
    const repair = functionBlock(source, "repairAndResumeSession").text;
    const abort = repair.indexOf("conversation has no resumable messages");
    expect(abort).toBeGreaterThan(-1);
    expect(repair.slice(abort, abort + 400)).toContain("unresumableConversations.add(convId)");
  });

  test("the exhausted path cancels when the resume is fatal and the conversation is unresumable", () => {
    const deliver = functionBlock(source, "deliverMessageIntoSession").text;
    const exhausted = deliver.indexOf("DELIVERY FAILED: all methods exhausted");
    const guard = deliver.indexOf("fatal && unresumableConversations.has(conversationId)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(exhausted);
    expect(deliver.slice(guard, guard + 300)).toContain("throw new UndeliverableMessageError(");
  });

  // jx79axm (2026-10-16): the machine rebooted while a fresh session's first
  // message was still being typed, so its agent died with no transcript. Every
  // retry then resumed the linked id, found nothing to rebuild, and gave up.
  test("a reconstitution that finds nothing resumable records the conversation", () => {
    const resume = functionBlock(source, "autoResumeSessionInner").text;
    const skip = resume.indexOf("Reconstitution skipped for");
    expect(skip).toBeGreaterThan(-1);
    expect(resume.slice(skip, skip + 300)).toContain("unresumableConversations.add(conversationId)");
  });

  test("a session that never started is started fresh instead of failing every retry", () => {
    const deliver = functionBlock(source, "deliverMessageIntoSession").text;
    const cancel = deliver.indexOf("fatal && unresumableConversations.has(conversationId)");
    const fresh = deliver.indexOf("unresumableConversations.has(conversationId) && !findSessionFile(sessionId)");
    const exhausted = deliver.indexOf("DELIVERY FAILED: all methods exhausted");
    expect(fresh).toBeGreaterThan(cancel);
    expect(fresh).toBeLessThan(exhausted);
    expect(deliver.slice(fresh, fresh + 400)).toContain("await deliverViaFreshStart()");
  });

  test("the delivery loop cancels an UndeliverableMessageError rather than retrying it", () => {
    const branch = source.indexOf("err instanceof UndeliverableMessageError");
    expect(branch).toBeGreaterThan(-1);
    const body = source.slice(branch, branch + 600);
    expect(body).toContain("cancelPendingMessage(msg._id)");
    expect(body).not.toContain("scheduleMessageRetry(");
  });
});
