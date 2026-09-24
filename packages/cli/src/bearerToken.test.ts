import { describe, expect, test } from "bun:test";
import { DEVICE_BOUND_TOKEN_PREFIX, splitPresentedToken } from "@platform/auth/cli";
import { REQUEST_DEVICE_BOUND_TOKENS, bearerFromStored, mintDeviceId, secretFromStored, storedFromBearer } from "./bearerToken.js";
import { deviceId } from "./remote/device.js";
import { decryptToken, encryptToken, isEncryptedToken } from "./tokenEncryption.js";

const PLAIN = "0123abcd";
const BOUND = `${DEVICE_BOUND_TOKEN_PREFIX}0123abcd`;

describe("what a stored token becomes on the wire", () => {
  test("an ordinary token is sent exactly as stored, encrypted or not", () => {
    expect(bearerFromStored(PLAIN)).toBe(PLAIN);
    expect(bearerFromStored(encryptToken(PLAIN))).toBe(PLAIN);
  });

  test("a bound token carries this machine's device id, computed at read time", () => {
    const bearer = bearerFromStored(encryptToken(BOUND));
    expect(splitPresentedToken(bearer)).toEqual({ secret: BOUND, deviceId: deviceId() });
    expect(bearerFromStored(BOUND)).toBe(bearer);
  });

  test("the secret is reachable without the device, for the paths that copy it", () => {
    expect(secretFromStored(encryptToken(BOUND))).toBe(BOUND);
  });
});

describe("what goes back into the file", () => {
  test("encrypts, and keeps a bound secret with the device it was minted for", () => {
    const stored = storedFromBearer(bearerFromStored(BOUND));
    expect(isEncryptedToken(stored)).toBe(true);
    expect(secretFromStored(stored)).toBe(BOUND);
    expect(decryptToken(stored)).toBe(`${BOUND}.${deviceId()}`);
    // A fresh mint arrives as the bare secret, bound to the machine that asked.
    expect(decryptToken(storedFromBearer(BOUND))).toBe(`${BOUND}.${deviceId()}`);
    expect(secretFromStored(storedFromBearer(PLAIN))).toBe(PLAIN);
  });

  test("leaves an already encrypted value alone", () => {
    const enc = encryptToken(PLAIN);
    expect(storedFromBearer(enc)).toBe(enc);
  });

  test("round trips through load and save without drift", () => {
    let stored = encryptToken(BOUND);
    for (let i = 0; i < 3; i++) stored = storedFromBearer(bearerFromStored(stored));
    expect(bearerFromStored(stored)).toBe(bearerFromStored(encryptToken(BOUND)));
  });
});

describe("asking for bound tokens at mint", () => {
  test("is ON: a new token names the device that minted it", () => {
    expect(REQUEST_DEVICE_BOUND_TOKENS).toBe(true);
    expect(mintDeviceId()).toBe(deviceId());
  });
});
