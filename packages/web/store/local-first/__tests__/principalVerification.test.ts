import { expect, test } from "bun:test";
import type { CredentialEvidence } from "../credentialBinding";
import {
  canRenderPrincipalProviderSubtree,
  PrincipalOfflineResolutionCoordinator,
  resolvePrincipalBoot,
  verifyPostCapturePrincipal,
} from "../principalVerification";
import type { CredentialBinding } from "../types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function token(principalId: string, sessionId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({ aud: "convex", iss: "test", sub: `${principalId}|${sessionId}` })}.signature`;
}

test("an A result arriving after A→B cannot fail, open, or authorize A", async () => {
  const principalA = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const principalB = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const sessionA = "cccccccccccccccccccccccc";
  const sessionB = "dddddddddddddddddddddddd";
  const responseA = deferred<{ _id: string }>();
  const responseB = deferred<{ _id: string }>();
  const evidenceA: CredentialEvidence = {
    binding: "binding-a" as CredentialBinding,
    sessionId: sessionA,
  };
  const evidenceB: CredentialEvidence = {
    binding: "binding-b" as CredentialBinding,
    sessionId: sessionB,
  };
  let activeGeneration = 1;
  const runtimeEvents: string[] = [];

  const attemptA = verifyPostCapturePrincipal({
    token: token(principalA, sessionA),
    evidence: evidenceA,
    queryCurrentPrincipal: () => responseA.promise,
    isCurrent: () => activeGeneration === 1,
    verify: async (_binding, principalId) => {
      runtimeEvents.push(`open:${principalId}`);
      return true;
    },
    failClosed: async () => { runtimeEvents.push("failed:A"); },
  });

  activeGeneration = 2;
  const attemptB = verifyPostCapturePrincipal({
    token: token(principalB, sessionB),
    evidence: evidenceB,
    queryCurrentPrincipal: () => responseB.promise,
    isCurrent: () => activeGeneration === 2,
    verify: async (_binding, principalId) => {
      runtimeEvents.push(`open:${principalId}`);
      return true;
    },
    failClosed: async () => { runtimeEvents.push("failed:B"); },
  });

  // The old reactive/cache result is delivered after B is already current.
  responseA.resolve({ _id: principalA });
  expect(await attemptA).toEqual({ kind: "stale" });
  expect(runtimeEvents).toEqual([]);

  responseB.resolve({ _id: principalB });
  expect(await attemptB).toEqual({ kind: "ready", principalId: principalB });
  expect(runtimeEvents).toEqual([`open:${principalB}`]);
});

test("a verified cached store becomes renderable before the server probe resolves", async () => {
  const principal = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const session = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const server = deferred<{ _id: string }>();
  const events: string[] = [];
  const attempt = resolvePrincipalBoot({
    token: token(principal, session),
    evidence: { binding: "binding-a" as CredentialBinding, sessionId: session },
    serverAuthenticated: true,
    isCurrent: () => true,
    resolveOffline: async () => {
      events.push("offline-opened");
      return true;
    },
    onOfflineReady: () => { events.push("render-cache"); },
    queryCurrentPrincipal: async () => {
      events.push("probe-started");
      return await server.promise;
    },
    verify: async () => {
      events.push("server-verified");
      return true;
    },
    failClosed: async () => { events.push("failed"); },
  });

  await Promise.resolve();
  expect(events).toEqual(["probe-started", "offline-opened", "render-cache"]);
  server.resolve({ _id: principal });
  expect(await attempt).toEqual({ kind: "ready", principalId: principal });
  expect(events).toEqual([
    "probe-started",
    "offline-opened",
    "render-cache",
    "server-verified",
  ]);
});

test("a transient verification failure preserves verified cached rendering", async () => {
  const events: string[] = [];
  const outcome = await resolvePrincipalBoot({
    token: token("aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"),
    evidence: {
      binding: "binding-a" as CredentialBinding,
      sessionId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    },
    serverAuthenticated: true,
    isCurrent: () => true,
    resolveOffline: async () => true,
    onOfflineReady: () => { events.push("render-cache"); },
    queryCurrentPrincipal: async () => { throw new Error("network unavailable"); },
    verify: async () => { events.push("verified"); return true; },
    failClosed: async () => { events.push("failed"); },
    onVerificationUnavailable: () => { events.push("verification-unavailable"); },
  });

  expect(outcome).toEqual({ kind: "offline-ready", verification: "unavailable" });
  expect(events).toEqual(["render-cache", "verification-unavailable"]);
});

test("a stale server result cannot verify or fail a cache opened by an old capture", async () => {
  const server = deferred<{ _id: string }>();
  const events: string[] = [];
  let current = true;
  const attempt = resolvePrincipalBoot({
    token: token("aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"),
    evidence: {
      binding: "binding-a" as CredentialBinding,
      sessionId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    },
    serverAuthenticated: true,
    isCurrent: () => current,
    resolveOffline: async () => true,
    onOfflineReady: () => { events.push("render-cache"); },
    queryCurrentPrincipal: async () => await server.promise,
    verify: async () => { events.push("verified"); return true; },
    failClosed: async () => { events.push("failed"); },
  });

  await Promise.resolve();
  current = false;
  server.resolve({ _id: "cccccccccccccccccccccccc" });
  expect(await attempt).toEqual({ kind: "stale" });
  expect(events).toEqual(["render-cache"]);
});

test("a first boot with no verified store still waits for server identity", async () => {
  const principal = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const session = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const server = deferred<{ _id: string }>();
  const events: string[] = [];
  const attempt = resolvePrincipalBoot({
    token: token(principal, session),
    evidence: { binding: "binding-a" as CredentialBinding, sessionId: session },
    serverAuthenticated: true,
    isCurrent: () => true,
    resolveOffline: async () => false,
    onOfflineReady: () => { events.push("render-cache"); },
    queryCurrentPrincipal: async () => await server.promise,
    verify: async () => { events.push("server-verified"); return true; },
    failClosed: async () => { events.push("failed"); },
  });

  await Promise.resolve();
  expect(events).toEqual([]);
  server.resolve({ _id: principal });
  expect(await attempt).toEqual({ kind: "ready", principalId: principal });
  expect(events).toEqual(["server-verified"]);
});

test("a definitive identity mismatch fails closed after the cached frame", async () => {
  const events: string[] = [];
  const outcome = await resolvePrincipalBoot({
    token: token("aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"),
    evidence: {
      binding: "binding-a" as CredentialBinding,
      sessionId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    },
    serverAuthenticated: true,
    isCurrent: () => true,
    resolveOffline: async () => true,
    onOfflineReady: () => { events.push("render-cache"); },
    queryCurrentPrincipal: async () => ({ _id: "cccccccccccccccccccccccc" }),
    verify: async () => { events.push("verified"); return true; },
    failClosed: async () => { events.push("failed-closed"); },
  });

  expect(outcome).toEqual({ kind: "unverified", reason: "identity-mismatch" });
  expect(events).toEqual(["render-cache", "failed-closed"]);
});

test("signed-out warm boot never starts a server probe", async () => {
  const events: string[] = [];
  const outcome = await resolvePrincipalBoot({
    token: null,
    evidence: { binding: "binding-a" as CredentialBinding, sessionId: null },
    serverAuthenticated: false,
    isCurrent: () => true,
    resolveOffline: async () => true,
    onOfflineReady: () => { events.push("render-cache"); },
    queryCurrentPrincipal: async () => {
      events.push("probe-started");
      return null;
    },
    verify: async () => { events.push("verified"); return true; },
    failClosed: async () => { events.push("failed-closed"); },
  });

  expect(outcome).toEqual({ kind: "offline-ready", verification: "not-requested" });
  expect(events).toEqual(["render-cache"]);
});

test("auth-state churn coalesces the same in-flight local-store open", async () => {
  const opening = deferred<boolean>();
  let opens = 0;
  const coordinator = new PrincipalOfflineResolutionCoordinator(async () => {
    opens++;
    return await opening.promise;
  });
  const binding = "binding-a" as CredentialBinding;

  const initialCapture = coordinator.resolve(binding);
  const tokenCapture = coordinator.resolve(binding);
  const authenticatedCapture = coordinator.resolve(binding);
  expect(opens).toBe(1);

  opening.resolve(true);
  expect(await Promise.all([initialCapture, tokenCapture, authenticatedCapture])).toEqual([
    true,
    true,
    true,
  ]);
});

// --- canRenderPrincipalProviderSubtree: token rotation must not unmount ---

const RENDER_PRINCIPAL = "aaaaaaaaaaaaaaaaaaaaaaaa";
const RENDER_SESSION = "bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_SESSION = "dddddddddddddddddddddddd";

function renderableState(phase: "offline-ready" | "server-verified") {
  return { phase } as unknown as Parameters<typeof canRenderPrincipalProviderSubtree>[0]["state"];
}

test("a rotated JWT in the same auth session keeps the subtree rendered", () => {
  // Convex auth exchanges the refresh token for a new JWT on boot/reconnect.
  // Regression: the gate compared raw token strings, so every rotation
  // collapsed the whole app to the loader until re-verification round-tripped.
  const before = token(RENDER_PRINCIPAL, RENDER_SESSION);
  const rotated = token(RENDER_PRINCIPAL, RENDER_SESSION) + "x"; // different string, same sub
  expect(canRenderPrincipalProviderSubtree({
    state: renderableState("server-verified"),
    token: rotated,
    authorizedToken: before,
    credentialResolution: { token: before, status: "ready" },
  })).toBe(true);
});

test("a token for a different principal collapses the gate synchronously", () => {
  const before = token(RENDER_PRINCIPAL, RENDER_SESSION);
  const otherPrincipal = token("cccccccccccccccccccccccc", RENDER_SESSION);
  expect(canRenderPrincipalProviderSubtree({
    state: renderableState("server-verified"),
    token: otherPrincipal,
    authorizedToken: before,
    credentialResolution: { token: before, status: "ready" },
  })).toBe(false);
});

test("a token for a different auth session (fresh sign-in) collapses the gate", () => {
  const before = token(RENDER_PRINCIPAL, RENDER_SESSION);
  const freshSignIn = token(RENDER_PRINCIPAL, OTHER_SESSION);
  expect(canRenderPrincipalProviderSubtree({
    state: renderableState("offline-ready"),
    token: freshSignIn,
    authorizedToken: before,
    credentialResolution: { token: before, status: "ready" },
  })).toBe(false);
});

test("sign-out (null token) collapses the gate", () => {
  const before = token(RENDER_PRINCIPAL, RENDER_SESSION);
  expect(canRenderPrincipalProviderSubtree({
    state: renderableState("server-verified"),
    token: null,
    authorizedToken: before,
    credentialResolution: { token: before, status: "ready" },
  })).toBe(false);
});

test("exact-match authorization still renders (no identity parsing needed)", () => {
  // Minted/dev tokens may not parse as convex-auth JWTs; string equality must
  // keep working for them.
  const opaque = "not-a-jwt";
  expect(canRenderPrincipalProviderSubtree({
    state: renderableState("offline-ready"),
    token: opaque,
    authorizedToken: opaque,
    credentialResolution: { token: opaque, status: "ready" },
  })).toBe(true);
});

test("an unauthorized capture still shows the loader", () => {
  expect(canRenderPrincipalProviderSubtree({
    state: renderableState("server-verified"),
    token: token(RENDER_PRINCIPAL, RENDER_SESSION),
    authorizedToken: null,
    credentialResolution: null,
  })).toBe(false);
});
