import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
const target = args.find((arg) => arg.startsWith("--target="))?.split("=")[1];

/**
 * Code splitting, for every compiled build (ct-49751).
 *
 * ct-49546 made the lazy command groups: `cast state` and `cast --help` reach
 * the group they need through an `await import()`, so the CLI no longer has to
 * evaluate every group to answer. Without `--splitting` that buys the binary
 * nothing — bun concatenates the dynamic imports into the one entry file, and
 * JSC parses the whole file before the first statement runs. With it, each
 * group lands in its own chunk that is read only when its verb runs.
 *
 * Measured on bun 1.3.14, darwin-arm64. The deterministic half, `cast
 * _boot-bytes` on two builds that differ only in this flag: 4,312,289 bytes
 * unsplit against 1,499 split in the release shape, and 7,110,947 against
 * 2,031 without `--minify`. The clock agrees but is coarser — median of 11
 * runs of `cast bench boot --binary`, twice over, on Developer ID signed
 * artifacts: `cast --help` 150/180 -> 120/100 ms CPU, `cast state` 160/180 ->
 * 110/110, `cast bogus` 150/190 -> 110/120. A signed binary pays a fixed
 * signature cost either way, which is why the clock moves by about a third
 * while the bytes move by three orders of magnitude.
 *
 * It rides here rather than in build-binaries.sh so `build:binary` and any
 * ad-hoc compile get the same shape as a release. `computer-helper-release.ts`
 * asserts the split survived into the artifact, because a bun that stopped
 * splitting under `--compile` would cost the win silently.
 */
const SPLIT_COMPILED_BUILDS = args.includes("--compile") && !args.includes("--splitting");
const needsMac = target?.includes("darwin") || (!target?.includes("linux") && !target?.includes("windows") && process.platform === "darwin");
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-native-build-"));
const run = (command: string, argv: string[]) => {
  const result = spawnSync(command, argv, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
};

const packageVersion = () => JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../package.json"), "utf8")).version as string;
const signIdentity = () => (process.env.CODECAST_SKIP_SIGN === "1" ? undefined : process.env.CODECAST_SIGN_IDENTITY);

/** Sign the way the browser icon helper is signed, then prove the signature reads back. */
function signAndVerify(target: string, identifier: string) {
  const identity = signIdentity();
  run("/usr/bin/codesign", ["--force", "--sign", identity || "-", "--identifier", identifier, "--options", "runtime", ...(identity ? ["--timestamp"] : []), target]);
  run("/usr/bin/codesign", ["--verify", "--strict", target]);
}

export const COMPUTER_HELPER_BUNDLE_ID = "sh.codecast.computer";
export const COMPUTER_HELPER_BUNDLE_NAME = "codecast computer";

/**
 * Where the helper payload waits to be bundled. `helperPayload.ts` imports this
 * path as a file, so bun embeds whatever bytes sit here into the CLI.
 *
 * It is a tracked empty file, written for the length of a build and truncated
 * again afterwards. The design asks for a `--define` carrying base64, the way
 * `browser-icon.m` rides one, but that route is closed: the app bundle tar is
 * about 2.6 MB of base64 and the whole argv must fit in ARG_MAX, so `bun build`
 * dies with E2BIG. A bundled file asset has no such limit and is the same
 * mechanism `browser/appIdentity.ts` already uses for its icon.
 */
export const COMPUTER_HELPER_PAYLOAD = path.join(import.meta.dir, "../src/computer/helper.tar");

/**
 * Compile the computer helper, wrap it in the app bundle that owns its TCC
 * grant, and write a tar of that bundle to `output`. A directory cannot be
 * embedded as one file, so the tar is the payload and the CLI unpacks it at the
 * fixed path.
 *
 * Writes an empty file when swift is absent, so a Linux build and a Mac without
 * Xcode both produce a working CLI that reports the feature unavailable. A
 * swift that is present and fails to compile is a hard error.
 */
export function buildComputerHelper(options: { stage: string; output: string; universal?: boolean; version?: string }): number {
  if (spawnSync("/usr/bin/env", ["swift", "--version"], { stdio: "ignore" }).status !== 0) {
    console.error("swift is not on PATH; building without the cast computer helper");
    fs.writeFileSync(options.output, "");
    return 0;
  }
  const source = path.join(import.meta.dir, "../native/computer-use-macos");
  const configuration = options.universal === false ? "debug" : "release";
  const architectures = options.universal === false ? [] : ["--arch", "arm64", "--arch", "x86_64"];
  const swiftArgs = ["swift", "build", "-c", configuration, ...architectures, "--package-path", source, "--scratch-path", path.join(options.stage, "swift")];
  const binPath = spawnSync("/usr/bin/env", [...swiftArgs, "--show-bin-path"], { encoding: "utf8" });
  if (binPath.status !== 0) throw new Error(`swift build --show-bin-path failed (${binPath.status})`);
  run("/usr/bin/env", swiftArgs);
  const binary = path.join(binPath.stdout.trim(), "codecast-computer");

  const bundle = path.join(options.stage, "bundle", `${COMPUTER_HELPER_BUNDLE_NAME}.app`);
  fs.mkdirSync(path.join(bundle, "Contents/MacOS"), { recursive: true });
  fs.copyFileSync(binary, path.join(bundle, "Contents/MacOS/codecast-computer"));
  fs.chmodSync(path.join(bundle, "Contents/MacOS/codecast-computer"), 0o755);
  // LSUIElement keeps the socket mode out of the Dock; the display name is what
  // the TCC dialog and the System Settings row show the human.
  fs.writeFileSync(path.join(bundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${COMPUTER_HELPER_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${COMPUTER_HELPER_BUNDLE_NAME}</string>
  <key>CFBundleDisplayName</key><string>${COMPUTER_HELPER_BUNDLE_NAME}</string>
  <key>CFBundleExecutable</key><string>codecast-computer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${options.version ?? packageVersion()}</string>
  <key>CFBundleVersion</key><string>${options.version ?? packageVersion()}</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAccessibilityUsageDescription</key><string>codecast computer reads and controls app windows for the cast computer command you ran.</string>
</dict>
</plist>
`);
  signAndVerify(bundle, COMPUTER_HELPER_BUNDLE_ID);

  run("/usr/bin/tar", ["-cf", options.output, "-C", path.dirname(bundle), path.basename(bundle)]);
  return fs.statSync(options.output).size;
}

/**
 * Delete the per-chunk `.map` files splitting leaves beside the outfile.
 *
 * They are build debris in an artifact directory: five targets writing about
 * 165 chunks each put ~500 files next to the five binaries, and `deploy.sh` and
 * `cut-cli-release.yml` both enumerate that directory by name. Nothing needs
 * them — a `--compile`d binary carries its own map and prints stack traces
 * against the original .ts files with no external map at all, for an eager
 * frame and a lazily imported one alike (checked on bun 1.3.14).
 * `<entry>.js.map` stays, because the release scripts ship it by that name.
 */
function dropChunkSourcemaps() {
  const outfile = args.find((arg) => arg.startsWith("--outfile="))?.split("=")[1];
  if (!outfile) return;
  const dir = path.dirname(path.resolve(outfile));
  for (const name of fs.readdirSync(dir)) {
    // Only bun's hashed chunk names, so a map a human left here survives.
    if (/-[0-9a-z]{8}\.js\.map$/.test(name)) fs.rmSync(path.join(dir, name));
  }
}

if (import.meta.main) {
  try {
    let helper = "";
    if (needsMac) {
      if (process.platform !== "darwin") throw new Error("Build macOS CLI releases on a Mac to compile the browser icon helper");
      const binary = path.join(stage, "browser-icon");
      run("/usr/bin/clang", ["-Os", "-fobjc-arc", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0", "-framework", "AppKit", path.join(import.meta.dir, "../native/browser-icon.m"), "-o", binary]);
      signAndVerify(binary, "sh.codecast.browser-icon");
      helper = fs.readFileSync(binary).toString("base64");
      // Why: build-binaries.sh compiles five targets, so a per-target swift
      // build would tar different mtimes and give darwin-arm64 and darwin-x64
      // DIFFERENT helpers — two hashes for one release, and nothing to record
      // in the artifact manifest as the helper's identity. It builds the bundle
      // once and points this at it instead (ct-49524).
      const prebuilt = process.env.CODECAST_COMPUTER_HELPER_TAR;
      if (prebuilt) {
        fs.copyFileSync(prebuilt, COMPUTER_HELPER_PAYLOAD);
        console.error(`cast computer helper: ${fs.statSync(COMPUTER_HELPER_PAYLOAD).size} bytes embedded from ${prebuilt}`);
      } else {
        console.error(`cast computer helper: ${buildComputerHelper({ stage, output: COMPUTER_HELPER_PAYLOAD })} bytes embedded`);
      }
    } else {
      fs.writeFileSync(COMPUTER_HELPER_PAYLOAD, "");
    }
    run(process.execPath, ["build", ...args, ...(SPLIT_COMPILED_BUILDS ? ["--splitting"] : []), "--define", `CODECAST_MAC_ICON_HELPER=${JSON.stringify(helper)}`]);
    if (SPLIT_COMPILED_BUILDS) dropChunkSourcemaps();
  } finally {
    // Leave the tracked placeholder empty again: the payload belongs in the
    // built binary, never in the working tree.
    fs.writeFileSync(COMPUTER_HELPER_PAYLOAD, "");
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
