import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const inboxSource = readFileSync(
  `${import.meta.dir}/../app/(tabs)/inbox.tsx`,
  "utf8",
);
const sheetSource = readFileSync(
  `${import.meta.dir}/../components/session/NewSessionSheet.tsx`,
  "utf8",
);
const authSource = readFileSync(
  `${import.meta.dir}/auth.tsx`,
  "utf8",
);
const layoutSource = readFileSync(
  `${import.meta.dir}/../app/_layout.tsx`,
  "utf8",
);

function sourceBetween(start: string, end: string, source = sheetSource): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("mobile result-dependent create callers", () => {
  // Starting a session is instant: the stub opens and the sheet closes in the
  // same tick, with the create's outbox row already on disk. Awaiting the server
  // here put a network round trip between the tap and the screen.
  test("session create navigates to the stub without awaiting the server", () => {
    const submit = sourceBetween("const handleSubmit", "\n  return (");
    expect(submit).toContain("deferCreate: true");
    expect(submit).not.toMatch(/\bawait\b/);
    const watch = submit.indexOf("watchSessionCreate(stubId, started.materialize(), create)");
    const finish = submit.indexOf("finishSessionCreate(stubId, empty)");
    expect(watch).toBeGreaterThanOrEqual(0);
    expect(finish).toBeGreaterThan(watch);
    const finishBody = sourceBetween("const finishSessionCreate", "const handleSubmit");
    // The session is pushed under the sheet, and the sheet closes only once
    // that screen has drawn, so it never slides off the screen it opened over.
    expect(finishBody).toContain("onSessionCreated(");
    expect(finishBody).not.toContain("onClose()");
    const host = sourceBetween("export function ComposeHost", "\n}\n");
    expect(host).toContain("awaitSessionLanding()");
    const sessionSource = readFileSync(`${import.meta.dir}/../app/session/[id].tsx`, "utf8");
    expect(sessionSource).toMatch(/if \(!reveal\) return;\s*sessionLanded\(\);/);
  });

  // The sheet is prompt first: typed words and picked images become the first
  // message, queued on the stub through the session composer's own send and
  // sent once the create has a real id, never awaited here.
  test("the sheet's words ride the stub as its first message", () => {
    const submit = sourceBetween("const handleSubmit", "\n  return (");
    expect(submit).toContain("dispatchComposerSend(stubId, text || IMAGE_ONLY_CONTENT, firstImages)");
    const composer = readFileSync(`${import.meta.dir}/../components/session/MessageComposer.tsx`, "utf8");
    const send = sourceBetween("export function dispatchComposerSend", "\n}\n", composer);
    expect(send).toContain("store.addOptimisticMessage(conversationId, content");
    expect(send).toContain("sendMessageWhenReady(conversationId, content");
  });

  // A refused create must not vanish silently once the sheet is gone: it is
  // raised with a retry that reuses the stub's session_id. A parked create is
  // durable and needs no prompt.
  test("a refused create raises a retry under the same session_id", () => {
    const watch = sourceBetween("function watchSessionCreate", "\n}\n");
    expect(watch).toContain("mobileCreateFailureDisposition(error)");
    expect(watch).toContain("create(stubId)");
    expect(watch).toContain("trackSessionCreate(stubId, retry)");
    expect(watch).toContain("resolveSessionId(stubId, convexId)");
  });

  test("label create exposes a retry instead of leaving a rejected promise", () => {
    const picker = sourceBetween(
      "const openLabelPicker",
      "const handleSessionLongPress",
      inboxSource,
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
    // The folder list is scoped only by an explicit machine pick.
    expect(sheetSource).toContain("useScopedRecentProjects({ scopedDeviceId: deviceId,");
    // The sheet paints from the store on open: machines and folders are fed
    // app-wide (StoreSyncBridge), never queried when the sheet appears.
    expect(sheetSource).not.toContain("api.devices.listDevices");
    expect(sheetSource).not.toContain("api.users.getRecentProjectPaths");
    // The machine row shows with any machine, so where a session runs is always in view.
    expect(sheetSource).toContain("devices.length > 0 &&");

    const builder = sourceBetween("const launchStampsForCreate", "const finishSessionCreate");
    expect(builder).toContain("deviceId && deviceId !== defaultDeviceId ? deviceId : undefined");
    expect(builder).toContain('model: model !== "default" ? model : undefined');
    expect(builder).toContain('effort: effort !== "default" ? effort : undefined');
    expect(builder).toContain('stable_mode: stableMode !== "auto" ? stableMode : undefined');
    expect(builder).toContain("isolated: isolated || undefined");
    // No preview to exclude from on mobile, so the sheet never collects one.
    expect(sheetSource).not.toContain("stable_exclude");
  });

  // Every launch option must ride the create mutation itself. A
  // create-then-reconfigure sequence enqueues TWO start_sessions — the
  // auto-routed machine spawns before the retarget lands, and two daemons end up
  // bound to one conversation (pl-224 review finding). One builder, spread into
  // every createSession call in the sheet, and no reconfigure path may exist.
  test("the options ride every create and never a follow-up reconfigure", () => {
    const creates = sheetSource.split("store.createSession(").length - 1;
    const stamped = sheetSource.split("...launchStampsForCreate(),").length - 1;
    expect(creates).toBeGreaterThan(0);
    expect(stamped).toBe(creates);
    expect(sheetSource).not.toContain('"reconfigureSession"');
    expect(sheetSource).not.toContain("reconfigureSession(");
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
    // Stamped before the create fires — after the rekey it's too late.
    const submit = sourceBetween("const handleSubmit", "\n  return (");
    const stampIndex = submit.indexOf("stampLabelIntent(stubId)");
    const materializeIndex = submit.indexOf("started.materialize()");
    expect(stampIndex).toBeGreaterThanOrEqual(0);
    expect(materializeIndex).toBeGreaterThan(stampIndex);
    // The dead-code shape this replaced must not come back.
    expect(sheetSource).not.toContain("awaitSessionCreate(conversationId)");
  });

  // listDevices' model_inventory is {hash, collected_at, clients} — feeding the
  // record itself to featuredModelOptions throws at render (inventory.filter is
  // not a function) the moment OpenCode or pi is selected on a machine that has
  // reported one.
  test("the dynamic rail indexes the inventory by client, never passes the record", () => {
    expect(sheetSource).toContain("model_inventory?.clients?.[");
    expect(sheetSource).not.toMatch(/featuredModelOptions\(inventory\b/);
  });

  // Re-tapping the already-active agent chip must not wipe a model/effort pick.
  test("only an actual agent switch resets the model rail", () => {
    expect(sheetSource).toContain("if (a.id === agentId) return");
  });

  // A sheet that reopens holding the last launch's choices would silently apply
  // them to the next session.
  test("a completed create resets every launch choice", () => {
    const finish = sourceBetween("const finishSessionCreate", "const handleSubmit");
    for (const reset of [
      'setProjectPath("")',
      "setDeviceId(null)",
      'setModel("default")',
      'setEffort("default")',
      'setStableMode("auto")',
      "setIsolated(false)",
      "setBucketPick(undefined)",
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

  // Kill-and-reopen used to hide the native splash as soon as fonts loaded,
  // then paint the inbox skeleton on an empty store until SQLite hydration
  // (or the live subscription) caught up. Splash now stays until the cache
  // is in memory, and the list only skeletons a genuinely cold empty cache.
  test("native splash stays up until the SQLite cache has hydrated", () => {
    expect(layoutSource).toContain("SplashScreen.preventAutoHideAsync()");
    expect(layoutSource).not.toMatch(/if\s*\(loaded\)\s*\{\s*SplashScreen\.hideAsync/);
    expect(authSource).toContain("shouldReleaseSplash({ hydrated, authDecision: renderDecision })");
    expect(authSource).toContain("s.clientStateInitialized");
    expect(authSource).toContain("SplashScreen.hideAsync()");
  });

  test("inbox skeletons only a cold empty cache, not a kill-and-reopen", () => {
    expect(inboxSource).toContain("s.clientStateInitialized");
    expect(inboxSource).toContain("if (!hydrated || sessionsFirstLoad !== false)");
  });
});

describe("mobile send button is a real tap target", () => {
  const sessionSource = readFileSync(
    `${import.meta.dir}/../app/session/[id].tsx`,
    "utf8",
  );
  const composerSource = readFileSync(
    `${import.meta.dir}/../components/chat/ChatComposerBar.tsx`,
    "utf8",
  );

  test("session send is 44pt and lives outside the jump overlay", () => {
    // The send button's size lives in the shared session style.
    const sharedStyle = readFileSync(`${import.meta.dir}/../../shared/render/mobileSessionStyle.ts`, "utf8");
    expect(sharedStyle).toMatch(/sendButton: \{[^}]*minWidth: 44[^}]*height: 44/);
    expect(sessionSource).toContain('keyboardShouldPersistTaps="always"');
    // Overlay is a child of the list pane, closed before composerLayer.
    const overlay = sessionSource.indexOf("styles.jumpButtonsOverlay");
    const overlayClose = sessionSource.indexOf("</Animated.View>", overlay);
    const composer = sessionSource.indexOf("styles.composerLayer");
    expect(overlay).toBeGreaterThan(-1);
    expect(composer).toBeGreaterThan(overlayClose);
  });

  test("chat send is 44pt", () => {
    expect(composerSource).toContain("width: 44");
    expect(composerSource).toContain("height: 44");
    expect(composerSource).toContain("hitSlop={12}");
  });
});
