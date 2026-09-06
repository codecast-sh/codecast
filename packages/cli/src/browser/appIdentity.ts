import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { browserHome } from "./profile.js";
import iconAsset from "./assets/cast-agent-chrome.png" with { type: "file" };

declare const CODECAST_MAC_ICON_HELPER: string;

export function shouldBrandBrowser(binary: string, headless: boolean, platform = process.platform, override = process.env.CODECAST_CHROMIUM): boolean {
  return platform === "darwin" && !headless && !override && binary.endsWith("/Google Chrome.app/Contents/MacOS/Google Chrome");
}

export function prepareBrowserApp(binary: string, headless: boolean): { binary: string; branded: boolean } {
  const unchanged = { binary, branded: false };
  if (!shouldBrandBrowser(binary, headless)) return unchanged;
  if (typeof CODECAST_MAC_ICON_HELPER !== "string" || !CODECAST_MAC_ICON_HELPER) return unchanged;
  const helper = Buffer.from(CODECAST_MAC_ICON_HELPER, "base64");
  const icon = fs.readFileSync(path.isAbsolute(iconAsset) ? iconAsset : fileURLToPath(new URL(iconAsset, import.meta.url)));
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  let root = path.join(browserHome(), "applications");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  root = fs.realpathSync(root);
  const helperPath = path.join(root, `browser-icon-${hash(helper)}`);
  const iconPath = path.join(root, `icon-${hash(icon)}.png`);
  for (const [file, bytes, mode] of [[helperPath, helper, 0o700], [iconPath, icon, 0o600]] as const) {
    if (fs.existsSync(file)) continue;
    const temporary = `${file}.${randomUUID()}`;
    fs.writeFileSync(temporary, bytes, { mode });
    fs.renameSync(temporary, file);
  }
  const source = binary.slice(0, binary.indexOf(".app/") + 4);
  const result = spawnSync(helperPath, [source, root, iconPath, `2-${hash(icon)}`], { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 });
  const appPath = result.stdout?.trim();
  if (result.status !== 0 || !appPath || !path.isAbsolute(appPath) || !appPath.startsWith(`${root}/version-`)) {
    console.error(`Cast Agent Chrome branding unavailable; using installed Chrome. ${result.error?.message || result.stderr?.trim() || "App preparation failed"}`);
    return unchanged;
  }
  const assessment = spawnSync("/usr/sbin/spctl", ["--assess", "--type", "execute", appPath], { encoding: "utf8", timeout: 30_000 });
  if (assessment.status !== 0) {
    console.error("Cast Agent Chrome did not pass macOS launch assessment; using installed Chrome.");
    return unchanged;
  }
  for (const app of [appPath, source]) {
    spawnSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app], { stdio: "ignore", timeout: 5000 });
  }
  return { binary: path.join(appPath, "Contents/MacOS/Google Chrome"), branded: true };
}
