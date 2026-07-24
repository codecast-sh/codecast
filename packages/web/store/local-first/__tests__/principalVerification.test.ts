import { expect, test } from "bun:test";
import type { CredentialEvidence } from "../credentialBinding";
import { verifyPostCapturePrincipal } from "../principalVerification";
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
