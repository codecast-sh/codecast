import { expect, test } from "bun:test";
import { unstampedHostLine } from "./commands";

// A host started before build stamps (the last release's) answers /status
// with no build, and no newer CLI retires it, so it keeps running without the
// new host's guardrails. Status has to say so and name the one step.
test("a host with no build stamp is reported with the step that replaces it", () => {
  const line = unstampedHostLine({}, 74967);
  expect(line).toContain("older cast");
  expect(line).toContain("`kill 74967`");
  expect(line).toContain("no re-pairing");
});

test("without a pid it still names the process to stop", () => {
  expect(unstampedHostLine({ build: undefined }, undefined)).toContain("cast browser bridge-host");
});

test("a stamped host says nothing", () => {
  expect(unstampedHostLine({ build: "1.1.213+5b7b1d662017.1794052567" }, 1)).toBeNull();
});
