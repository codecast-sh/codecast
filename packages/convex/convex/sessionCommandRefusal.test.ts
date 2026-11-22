import { describe, expect, test } from "bun:test";
import { ConvexError } from "convex/values";
import { requireSessionCommandTarget, resumeConversationSession } from "./daemonCommandUtils";
import { makeFakeDb } from "./testDb";

// ct-91098 / eg-2899: a viewer on /threads sent convCommand("resumeSession")
// for a session they neither run nor own. The refusal was a plain Error, which
// Convex reports to the client as "[CONVEX M(dispatch:dispatch)] Server Error"
// and the web reporter logged as a new server error. An expected "you may not
// command this session" must reach the client as a typed ConvexError carrying
// a code, so the client can tell it from a real server failure.

const RUNNER = "users_runner" as any;
const OWNER = "users_owner" as any;
const STRANGER = "users_stranger" as any;
const conv = { _id: "conversations_1", user_id: RUNNER, owner_user_id: OWNER, session_id: "s1" };

async function refusal(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal, but the call succeeded");
}

function expectTypedRefusal(err: unknown) {
  expect(err).toBeInstanceOf(ConvexError);
  const data = (err as ConvexError<any>).data;
  expect(typeof data).toBe("object");
  expect(typeof data?.code).toBe("string");
}

describe("a session command from someone who may not command the session", () => {
  test("requireSessionCommandTarget refuses with a typed ConvexError, not a plain Error", async () => {
    const ctx = { db: makeFakeDb({ conversations: [conv] }) } as any;
    expectTypedRefusal(await refusal(requireSessionCommandTarget(ctx, STRANGER, "conversations_1" as any)));
  });

  test("resume (the convCommand resumeSession core) refuses with a typed ConvexError", async () => {
    const ctx = { db: makeFakeDb({ conversations: [conv] }) } as any;
    expectTypedRefusal(await refusal(resumeConversationSession(ctx, STRANGER, "conversations_1" as any)));
  });

  test("the runner and the second-party owner are still let through", async () => {
    const ctx = { db: makeFakeDb({ conversations: [conv] }) } as any;
    expect((await requireSessionCommandTarget(ctx, RUNNER, "conversations_1" as any)).user_id).toBe(RUNNER);
    expect((await requireSessionCommandTarget(ctx, OWNER, "conversations_1" as any)).user_id).toBe(RUNNER);
  });
});
