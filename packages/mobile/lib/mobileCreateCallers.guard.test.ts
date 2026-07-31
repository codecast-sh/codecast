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

    const apply = sourceBetween("const applyMachinePick", "const finishSessionCreate");
    // Stamping the default would short-circuit routing past the rung that
    // prefers the machine holding the checkout, so it must stay unsent.
    expect(apply).toContain("if (!deviceId || deviceId === defaultDeviceId) return;");
    expect(apply).toContain("target_device_id: deviceId");
  });

  // A just-created row can still carry a local stub id, so the pick must follow
  // it to its real one (the web ProjectSwitcher's chain) instead of dropping.
  test("an explicit pick resolves a stub id before commanding the session", () => {
    const apply = sourceBetween("const applyMachinePick", "const finishSessionCreate");
    const cached = apply.indexOf("store.getConvexId(id)");
    const inFlight = apply.indexOf("store.awaitSessionCreate(id)");
    const command = apply.indexOf('"reconfigureSession"');

    expect(cached).toBeGreaterThanOrEqual(0);
    expect(inFlight).toBeGreaterThan(cached);
    expect(command).toBeGreaterThan(inFlight);
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
