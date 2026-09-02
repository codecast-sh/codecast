import { describe, expect, test } from "bun:test";
import { appleNativeSignInParams } from "./appleNative";
import { parseAccessIdentity } from "./accessIdentity";

describe("appleNativeSignInParams", () => {
  test("forwards name and email only when Apple provided them", () => {
    expect(
      appleNativeSignInParams({
        identityToken: "tok",
        email: "a@b.c",
        fullName: { givenName: "Ada", familyName: "Lovelace" },
      }),
    ).toEqual({ idToken: "tok", email: "a@b.c", fullName: "Ada Lovelace" });
    expect(appleNativeSignInParams({ identityToken: "tok", email: null, fullName: null })).toEqual({ idToken: "tok" });
  });

  test("throws without an identity token", () => {
    expect(() => appleNativeSignInParams({ identityToken: null })).toThrow("No identity token");
  });
});

function jwt(header: object, payload: object): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc(header)}.${enc(payload)}.sig`;
}

describe("parseAccessIdentity", () => {
  test("reads principal and subject from a Convex Auth JWT", () => {
    const token = jwt({ alg: "RS256" }, { aud: "convex", iss: "https://x.convex.site", sub: "userA|sess1" });
    expect(parseAccessIdentity(token)).toEqual({ principalId: "userA", subject: "userA|sess1" });
  });

  test("rejects tokens with the wrong shape", () => {
    expect(parseAccessIdentity(null)).toBeNull();
    expect(parseAccessIdentity("nope")).toBeNull();
    expect(parseAccessIdentity(jwt({ alg: "HS256" }, { aud: "convex", iss: "i", sub: "a|b" }))).toBeNull();
    expect(parseAccessIdentity(jwt({ alg: "RS256" }, { aud: "other", iss: "i", sub: "a|b" }))).toBeNull();
    expect(parseAccessIdentity(jwt({ alg: "RS256" }, { aud: "convex", iss: "i", sub: "a|b|c" }))).toBeNull();
  });
});
