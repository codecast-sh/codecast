import { expect, test } from "bun:test";
import { isAdvancedClone, withAdvancedClone } from "./advanced.js";

test("advanced clone scope cannot leak into concurrent or later commands", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const command = withAdvancedClone(async () => {
    expect(isAdvancedClone()).toBe(true);
    await ready;
    expect(isAdvancedClone()).toBe(true);
  });
  expect(isAdvancedClone()).toBe(false);
  release();
  await command;
  expect(isAdvancedClone()).toBe(false);
});

test("a failed advanced command leaves the ordinary default intact", () => {
  expect(() => withAdvancedClone(() => { throw new Error("failed command"); })).toThrow("failed command");
  expect(isAdvancedClone()).toBe(false);
});
