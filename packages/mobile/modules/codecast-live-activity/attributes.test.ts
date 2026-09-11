import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_ACTIVITY_ATTRIBUTES_TYPE, LIVE_ACTIVITY_SCHEMA_VERSION } from "@codecast/shared/contracts";

// The ActivityAttributes struct exists twice on purpose (the app's native
// module and the widget extension cannot share a pod), and ActivityKit
// decodes the server's content state with it BY NAME. These guards keep the
// two copies one struct and the struct the server's contract.

const here = import.meta.dir;
const appCopy = readFileSync(join(here, "ios/CodecastActivityAttributes.swift"), "utf8");
const widgetCopy = readFileSync(join(here, "../../targets/widget/CodecastActivityAttributes.swift"), "utf8");

describe("CodecastActivityAttributes", () => {
  test("the widget's copy is byte-identical to the app module's", () => {
    expect(widgetCopy).toBe(appCopy);
  });

  test("the struct carries the name the server's push-to-start names", () => {
    expect(appCopy).toContain(`public struct ${LIVE_ACTIVITY_ATTRIBUTES_TYPE}: ActivityAttributes`);
  });

  test("the schema version matches the shared contract", () => {
    expect(appCopy).toContain(`public static let schemaVersion = ${LIVE_ACTIVITY_SCHEMA_VERSION}`);
  });

  test("every wire field of the content state is declared, optionals as optionals", () => {
    for (const line of [
      "public var version: Int",
      "public var headline: String",
      "public var detail: String?",
      "public var status: String",
      "public var live: Int",
      "public var waiting: Int",
      "public var overflow: Int",
      "public var sessions: [CodecastActivitySession]",
      "public var updatedAt: String",
      "public var project: String?",
      "public var startedAt: String",
    ]) {
      expect(appCopy).toContain(line);
    }
  });
});
