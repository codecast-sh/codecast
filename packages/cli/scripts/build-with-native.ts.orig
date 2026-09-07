import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const args = process.argv.slice(2);
const target = args.find((arg) => arg.startsWith("--target="))?.split("=")[1];
const needsMac = target?.includes("darwin") || (!target?.includes("linux") && !target?.includes("windows") && process.platform === "darwin");
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cast-native-build-"));
const run = (command: string, argv: string[]) => {
  const result = spawnSync(command, argv, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
};

try {
  let helper = "";
  if (needsMac) {
    if (process.platform !== "darwin") throw new Error("Build macOS CLI releases on a Mac to compile the browser icon helper");
    const binary = path.join(stage, "browser-icon");
    run("/usr/bin/clang", ["-Os", "-fobjc-arc", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0", "-framework", "AppKit", path.join(import.meta.dir, "../native/browser-icon.m"), "-o", binary]);
    const identity = process.env.CODECAST_SKIP_SIGN === "1" ? undefined : process.env.CODECAST_SIGN_IDENTITY;
    run("/usr/bin/codesign", ["--force", "--sign", identity || "-", "--identifier", "sh.codecast.browser-icon", "--options", "runtime", ...(identity ? ["--timestamp"] : []), binary]);
    run("/usr/bin/codesign", ["--verify", "--strict", binary]);
    helper = fs.readFileSync(binary).toString("base64");
  }
  run(process.execPath, ["build", ...args, "--define", `CODECAST_MAC_ICON_HELPER=${JSON.stringify(helper)}`]);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
