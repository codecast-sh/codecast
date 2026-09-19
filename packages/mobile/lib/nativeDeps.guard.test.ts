import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { staticImportSpecifiers } from "../../cli/src/bench/bootGraph";

// Enforces the convention in lib/optionalNative.ts. A static import of a native
// package that the oldest binary in the field does not contain kills that
// binary at boot, or rolls every OTA update back in silence.

const mobileRoot = path.resolve(import.meta.dir, "..");
const NATIVE_MARKERS = ["ios", "android", "expo-module.config.json", "react-native.config.js"];

// Native packages every supported binary contains, so a static import is safe.
// This list is FROZEN. Do not add a package to make this test pass: a package
// that is new to package.json is, by definition, absent from binaries already
// installed. Load it through optionalNative and give the caller a path for null.
// Add a name here only after the oldest binary in the field contains it.
const BASELINE = new Set([
  "expo",
  "expo-apple-authentication",
  "expo-constants",
  "expo-device",
  "expo-font",
  "expo-haptics",
  "expo-linking",
  "expo-local-authentication",
  "expo-notifications",
  "expo-router",
  "expo-secure-store",
  "expo-splash-screen",
  "expo-updates", // a binary that receives an OTA update has it by definition
  "expo-web-browser",
  "react-native",
  "react-native-reanimated",
  "react-native-safe-area-context",
  "react-native-svg",
]);

const nativeDeps = Object.keys(
  JSON.parse(fs.readFileSync(path.join(mobileRoot, "package.json"), "utf8")).dependencies,
).filter((name) => NATIVE_MARKERS.some((m) => fs.existsSync(path.join(mobileRoot, "node_modules", name, m))));

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "ios", "android", "dist", ".expo", "targets"].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name)) out.push(p);
    }
  })(mobileRoot);
  return out;
}

const packageOf = (spec: string) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

describe("native dependency convention", () => {
  const files = sourceFiles().map((file) => ({ file, source: fs.readFileSync(file, "utf8") }));
  const rel = (f: string) => path.relative(mobileRoot, f);

  test("a native package outside the baseline is never imported statically", () => {
    const offenders: string[] = [];
    for (const { file, source } of files) {
      for (const spec of staticImportSpecifiers(source)) {
        const pkg = packageOf(spec);
        if (nativeDeps.includes(pkg) && !BASELINE.has(pkg)) offenders.push(`${rel(file)} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the baseline names only installed native packages", () => {
    expect([...BASELINE].filter((name) => !nativeDeps.includes(name))).toEqual([]);
  });

  // Guarded requires that predate the helper. Remove a name when its file
  // moves onto optionalNative; never add one.
  const HAND_WRITTEN_PROBES = new Set([
    "components/CastCanvas.tsx", // in another session's hands when the helper landed
    "app/session/[id].tsx", // same
    "lib/asrCapture.ts",
    "lib/clipboard.ts", // falls back to the React Native clipboard, not to null
    "lib/dispatchOutbox.ts", // must reject, not return null: the send journal fails honestly
    "hooks/useNotificationCatchUp.ts", // falls back to a storage shim under test
  ]);

  test("a lazy require of a native package goes through optionalNative", () => {
    const offenders: string[] = [];
    for (const { file, source } of files) {
      if (HAND_WRITTEN_PROBES.has(rel(file)) || rel(file) === "lib/optionalNative.ts") continue;
      const lazy = [...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)]
        .map((m) => packageOf(m[1]))
        .filter((pkg) => nativeDeps.includes(pkg) && !BASELINE.has(pkg));
      if (lazy.length > 0 && !/\b(optionalNative|nativeModulePresent)\(/.test(source)) {
        offenders.push(`${rel(file)} requires ${[...new Set(lazy)].join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
