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
      "\n  return (",
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

describe("mobile new-session launch options", () => {
  // The sheet's safety property: until the user moves a control OFF its default,
  // the create must look exactly as it did before that control existed — folder
  // query unscoped, no target, no model/effort/stable/isolated flags — so the
  // agent's and the machine's own defaults keep deciding. Stamping the default
  // is not a no-op: a target short-circuits routing past the rung that prefers
  // the machine holding the checkout, and stable_mode overrides `cast stable`.
  test("only explicit non-default picks are stamped", () => {
    expect(inboxSource).toContain("deviceId ? { device_id: deviceId } : {}");
    expect(inboxSource).toContain("devices.length > 1 &&");

    const builder = sourceBetween("const launchStampsForCreate", "const finishSessionCreate");
    expect(builder).toContain("deviceId && deviceId !== defaultDeviceId ? deviceId : undefined");
    expect(builder).toContain('model: model !== "default" ? model : undefined');
    expect(builder).toContain('effort: effort !== "default" ? effort : undefined');
    expect(builder).toContain('stable_mode: stableMode !== "auto" ? stableMode : undefined');
    expect(builder).toContain("isolated: isolated || undefined");
    // No preview to exclude from on mobile, so the sheet never collects one.
    expect(inboxSource).not.toContain("stable_exclude");
  });

  // Every launch option must ride the create mutation itself. A
  // create-then-reconfigure sequence enqueues TWO start_sessions — the
  // auto-routed machine spawns before the retarget lands, and two daemons end up
  // bound to one conversation (pl-224 review finding). One builder, spread into
  // every createSession call in the sheet, and no reconfigure path may exist.
  test("the options ride every create and never a follow-up reconfigure", () => {
    const creates = inboxSource.split("store.createSession(").length - 1;
    const stamped = inboxSource.split("...launchStampsForCreate(),").length - 1;
    expect(creates).toBeGreaterThan(0);
    expect(stamped).toBe(creates);
    expect(inboxSource).not.toContain('"reconfigureSession"');
    expect(inboxSource).not.toContain("reconfigureSession(");
  });

  // Bucket filing doesn't affect the spawn, but it must survive a create that
  // parks offline. The only mechanism that does is the store's
  // _postCreateBucketId marker (preserveFields; replayed on the stub→real
  // rekey) — awaiting the tracked create promise is a race lost by design,
  // because trackSessionCreate reaps pendingSessionCreates first.
  test("the label rides the post-create marker, stamped before the create resolves", () => {
    const stamp = sourceBetween("const stampLabelIntent", "const finishSessionCreate");
    // Untouched pill = inherit: the store stamped the focused chip's bucket
    // itself, so the sheet must write nothing.
    expect(stamp).toContain("if (bucketPick === undefined) return");
    expect(stamp).toContain("_postCreateBucketId");
    // Stamped synchronously before the await — after the rekey it's too late.
    const submit = sourceBetween("const handleSubmit", "\n  return (");
    const stampIndex = submit.indexOf("stampLabelIntent(stubId)");
    const awaitIndex = submit.indexOf("await ready");
    expect(stampIndex).toBeGreaterThanOrEqual(0);
    expect(awaitIndex).toBeGreaterThan(stampIndex);
    // The already-resolved retry has no stub rows; the finish path assigns
    // directly, guarded so a marker replay can't double-file.
    const finish = sourceBetween("const finishSessionCreate", "const handleClose");
    expect(finish).toContain("isConvexId(conversationId)");
    expect(finish).toContain("assignSessionToBucket");
    expect(finish).toContain("convBucketMap");
    // The dead-code shape this replaced must not come back.
    expect(inboxSource).not.toContain("awaitSessionCreate(conversationId)");
  });

  // listDevices' model_inventory is {hash, collected_at, clients} — feeding the
  // record itself to featuredModelOptions throws at render (inventory.filter is
  // not a function) the moment OpenCode or pi is selected on a machine that has
  // reported one.
  test("the dynamic rail indexes the inventory by client, never passes the record", () => {
    expect(inboxSource).toContain("model_inventory?.clients?.[");
    expect(inboxSource).not.toMatch(/featuredModelOptions\(inventory\b/);
  });

  // Re-tapping the already-active agent chip must not wipe a model/effort pick.
  test("only an actual agent switch resets the model rail", () => {
    expect(inboxSource).toContain("if (a.id === agentId) return");
  });

  // A sheet that reopens holding the last launch's choices would silently apply
  // them to the next session.
  test("a completed create resets every launch choice", () => {
    const finish = sourceBetween("const finishSessionCreate", "const handleClose");
    for (const reset of [
      'setProjectPath("")',
      "setDeviceId(null)",
      'setModel("default")',
      'setEffort("default")',
      'setStableMode("auto")',
      "setIsolated(false)",
      "setBucketPick(undefined)",
      "setShowAllRecents(false)",
    ]) {
      expect(finish).toContain(reset);
    }
  });
});

describe("mobile principal outbox binding", () => {
  test("binds trusted-principal storage and immediately replays it", () => {
    expect(authSource).toContain("openPrincipalDispatchOutbox(principalId)");
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

  // Local-first boot: rendering gates on the LOCAL token + persisted anchor
  // (authTrust), never on server-confirmed auth — the server round-trip only
  // verifies and revokes. The anchor is written strictly inside the verified
  // branch, so a token the server never confirmed can't earn next-boot trust.
  test("render trust is local; the anchor persists only after verification", () => {
    expect(authSource).toContain("localBootTrust({");
    expect(authSource).toContain("authRenderDecision({");
    const verified = authSource.indexOf("setVerifiedSubject(verified ? accessIdentity.subject : null)");
    const persist = authSource.indexOf("SecureStore.setItemAsync(LAST_PRINCIPAL_KEY", verified);
    const guard = authSource.indexOf("if (verified) {", verified);
    expect(verified).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(verified);
    expect(persist).toBeGreaterThan(guard);
  });

  // The store clears on a PRINCIPAL change only. Clearing on every subject
  // change wiped the just-hydrated SQLite cache on each boot the moment
  // verification landed — the bug that made the phone boot server-first.
  test("memory clears on principal change, never on the boot subject transition", () => {
    expect(authSource).toContain("shouldClearMemoryFor(memoryPrincipal.current, trustedPrincipalId)");
    expect(authSource).not.toMatch(/lastTrustedSubject\.current !== trustedSubject\) \{\s*\n\s*clearProtectedInboxMemory/);
  });

  test("surfaces an outbox-open failure with an in-place retry while writes stay gated", () => {
    expect(authSource).toContain("Local storage is unavailable");
    expect(authSource).toContain(
      "setOutboxOpenAttempt((attempt) => attempt + 1)",
    );
    expect(authSource).toContain("outboxFailureSubject: outboxFailure?.subject ?? null");
    expect(authSource).toContain(
      "Codecast kept writing disabled so no work can be lost.",
    );
  });

  test("closes the old enqueue surface during the auth transition render", () => {
    const transition = authSource.indexOf(
      "if (outboxSubject.current !== trustedSubject)",
    );
    const clear = authSource.indexOf("_setOutbox(null, null, null)", transition);
    const open = authSource.indexOf(
      "openPrincipalDispatchOutbox(principalId)",
    );

    expect(transition).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(transition);
    expect(open).toBeGreaterThan(clear);
  });
});
