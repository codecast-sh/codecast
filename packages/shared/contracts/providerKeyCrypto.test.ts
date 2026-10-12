import { describe, expect, test } from "bun:test";
import { managedIdsAfter } from "./providerKeyCrypto";

// The server mirrors this onto the device row and the web paints it first.
describe("managedIdsAfter", () => {
  const payload = (provider: string) => ({ provider, epk: "e", iv: "i", ct: "c" });

  test("a set adds the sealed key's provider once, sorted", () => {
    expect(managedIdsAfter(["openai"], { op: "set", payload: payload("anthropic") })).toEqual(["anthropic", "openai"]);
    expect(managedIdsAfter(["openai"], { op: "set", payload: payload("openai") })).toEqual(["openai"]);
    expect(managedIdsAfter(undefined, { op: "set", payload: payload("openai") })).toEqual(["openai"]);
  });

  test("a remove drops only the named provider", () => {
    expect(managedIdsAfter(["anthropic", "openai"], { op: "remove", provider: "openai" })).toEqual(["anthropic"]);
    expect(managedIdsAfter(null, { op: "remove", provider: "openai" })).toEqual([]);
  });
});
