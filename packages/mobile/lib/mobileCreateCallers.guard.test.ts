import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const inboxSource = readFileSync(
  `${import.meta.dir}/../app/(tabs)/inbox.tsx`,
  "utf8",
);
const authSource = readFileSync(
  `${import.meta.dir}/auth.tsx`,
  "utf8",
);

function sourceBetween(start: string, end: string): string {
  const startIndex = inboxSource.indexOf(start);
  const endIndex = inboxSource.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return inboxSource.slice(startIndex, endIndex);
}

describe("mobile result-dependent create callers", () => {
  test("session create observes readiness before closing or navigating", () => {
    const submit = sourceBetween(
      "const handleSubmit",
      "const agents:",
    );
    const awaitIndex = submit.indexOf("await ready");
    const finishIndex = submit.indexOf("finishSessionCreate(", awaitIndex);
    const retainStubIndex = submit.indexOf("retryStubId.current = stubId");
    const materializeIndex = submit.indexOf("started.materialize()");
    const finish = sourceBetween(
      "const finishSessionCreate",
      "const handleClose",
    );

    expect(submit).toContain("mobileCreateFailureDisposition");
    expect(submit).toContain("deferCreate: true");
    expect(retainStubIndex).toBeGreaterThanOrEqual(0);
    expect(materializeIndex).toBeGreaterThan(retainStubIndex);
    expect(awaitIndex).toBeGreaterThanOrEqual(0);
    expect(finishIndex).toBeGreaterThan(awaitIndex);
    expect(finish).toContain("onClose()");
    expect(finish).toContain("onSessionCreated(");
  });

  test("label create exposes a retry instead of leaving a rejected promise", () => {
    const picker = sourceBetween(
      "const openLabelPicker",
      "const handleSessionLongPress",
    );

    expect(picker).toContain("mobileCreateFailureDisposition");
    expect(picker).toContain('kind: "assignBucket"');
    expect(picker).toContain("conversationIds: [session._id]");
    expect(picker).toContain("Couldn't create label");
    expect(picker).toContain("Retry");
    expect(picker).toMatch(/catch\s*\(/);
  });
});

describe("mobile machine picker", () => {
  // The picker's safety property: until the user picks a machine by hand, the
  // sheet must behave exactly as it did before the row existed — folder query
  // unscoped, create untargeted, so routing keeps choosing.
  test("only an explicit pick scopes the folder query and targets the create", () => {
    expect(inboxSource).toContain("deviceId ? { device_id: deviceId } : {}");
    expect(inboxSource).toContain("devices.length > 1 &&");

    // Stamping the default would short-circuit routing past the rung that
    // prefers the machine holding the checkout, so it must stay unsent.
    const pick = sourceBetween("const machinePickForCreate", "const finishSessionCreate");
    expect(pick).toContain("deviceId && deviceId !== defaultDeviceId ? deviceId : undefined");
  });

  // The pick must ride the create mutation itself. A create-then-reconfigure
  // sequence enqueues TWO start_sessions — the auto-routed machine spawns
  // before the retarget lands, and two daemons end up bound to one
  // conversation (pl-224 review finding). Every createSession call in the
  // sheet must carry the stamp, and no reconfigure path may exist.
  test("the pick rides every create and never a follow-up reconfigure", () => {
    const creates = inboxSource.split("store.createSession(").length - 1;
    const stamped = inboxSource.split("target_device_id: machinePickForCreate()").length - 1;
    expect(creates).toBeGreaterThan(0);
    expect(stamped).toBe(creates);
    expect(inboxSource).not.toContain('"reconfigureSession"');
  });
});

describe("mobile principal outbox binding", () => {
  test("binds verified-principal storage and immediately replays it", () => {
    expect(authSource).toContain("openPrincipalDispatchOutbox(currentUserId)");
    expect(authSource).toContain(
      "store._setOutbox(outbox.enqueue, outbox.remove, outbox.load)",
    );
    const install = authSource.indexOf(
      "store._setOutbox(outbox.enqueue, outbox.remove, outbox.load)",
    );
    const ready = authSource.indexOf("setOutboxReadySubject(subject)", install);
    expect(ready).toBeGreaterThan(install);
    expect(authSource).toContain("store._drainOutbox()");
  });

  test("keeps dispatch authorization and writable children closed until storage opens", () => {
    expect(authSource).toContain(
      "outboxReadySubject === visibleSubject",
    );
    expect(authSource).toContain(
      "durableSubject ? dispatchGeneration.current : null",
    );
    expect(authSource).toContain(
      "isAuthenticated && !durableSubject",
    );
    expect(authSource).toContain(": children}");
  });

  test("surfaces an outbox-open failure with an in-place retry while writes stay gated", () => {
    expect(authSource).toContain("Local storage is unavailable");
    expect(authSource).toContain(
      "setOutboxOpenAttempt((attempt) => attempt + 1)",
    );
    expect(authSource).toContain(
      "outboxFailure?.subject === visibleSubject",
    );
    expect(authSource).toContain(
      "Codecast kept writing disabled so no work can be lost.",
    );
  });

  test("closes the old enqueue surface during the auth transition render", () => {
    const transition = authSource.indexOf(
      "if (outboxSubject.current !== visibleSubject)",
    );
    const clear = authSource.indexOf("_setOutbox(null, null, null)", transition);
    const open = authSource.indexOf(
      "openPrincipalDispatchOutbox(currentUserId)",
    );

    expect(transition).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(transition);
    expect(open).toBeGreaterThan(clear);
  });
});
