// Builds, seals and registers one installed app's macOS bundle:
//   <root>/<Name>.app            root defaults to ~/Applications/Codecast Apps
//     Contents/Info.plist        bundle id sh.codecast.app.<slug>, Codecast* keys the shim reads
//     Contents/MacOS/<Name>      the shim, copied from Codecast.app's Resources
//     Contents/Resources/app.icns
//     Contents/Resources/client.js the page client (window.cast.app), injected at document start
// Copying the Developer-ID-signed shim into a new bundle with a new Info.plist
// breaks its seal (the signature covers the plist), so every bundle is re-sealed
// ad hoc here. Hardened runtime and entitlements are not needed: WebKit runs
// page JavaScript in its own Apple-signed processes.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { clientSource } = require("../installedApps/protocol");

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const ICON_SIZES = [16, 32, 128, 256, 512];

const defaultRoot = () => path.join(os.homedir(), "Applications", "Codecast Apps");
const bundleId = (slug) => `sh.codecast.app.${slug}`;

/** A file name Finder and Launch Services accept; the display name stays as given. */
function bundleName(name) {
  const clean = String(name ?? "").replace(/[/:\\\u0000-\u001f]/g, "-").replace(/^\.+/, "").trim().slice(0, 64);
  if (!clean) throw new Error("installed app needs a name");
  return clean;
}

const bundlePath = (name, root = defaultRoot()) => path.join(root, `${bundleName(name)}.app`);

/**
 * The bundle path for an app named `name` in `root` that no other app holds:
 * `<Name>.app`, else `<Name> 2.app`, `<Name> 3.app`... `ownedBy(appPath)` says
 * whether an existing bundle is this app's own (a reinstall replaces it).
 */
function freeBundlePath(name, root, ownedBy) {
  const base = bundleName(name);
  for (let n = 1; ; n++) {
    const candidate = path.join(root, `${n === 1 ? base : `${base} ${n}`}.app`);
    if (!fs.existsSync(candidate) || ownedBy(candidate)) return candidate;
  }
}

function checkSlug(slug) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(slug ?? "")) throw new Error(`bad slug for a bundle id: ${slug}`);
}

const xmlEscape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist(dict) {
  const value = (v) =>
    typeof v === "boolean" ? `<${v}/>`
      : typeof v === "number" ? `<integer>${Math.round(v)}</integer>`
        : `<string>${xmlEscape(v)}</string>`;
  const body = Object.entries(dict)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `\t<key>${xmlEscape(k)}</key>\n\t${value(v)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

function infoPlist({ slug, name, pageUrl, hostBundleId, socketPath, hostVersion, sealKey, window = {}, tray = {}, version = "1" }) {
  return plist({
    CFBundleIdentifier: bundleId(slug),
    CFBundleName: name.slice(0, 64),
    CFBundleDisplayName: name,
    CFBundleExecutable: bundleName(name),
    CFBundleIconFile: "app",
    CFBundlePackageType: "APPL",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleShortVersionString: String(version),
    CFBundleVersion: String(version),
    LSMinimumSystemVersion: "12.0",
    NSPrincipalClass: "NSApplication",
    NSHighResolutionCapable: true,
    NSSupportsAutomaticTermination: false,
    CodecastAppSlug: slug,
    CodecastHostBundleId: hostBundleId ?? "sh.codecast.desktop",
    CodecastPageUrl: pageUrl,
    CodecastSocketPath: socketPath,
    CodecastHostVersion: hostVersion,
    CodecastSealKey: sealKey,
    CodecastWindowWidth: window.width,
    CodecastWindowHeight: window.height,
    CodecastTrayWidth: tray.width,
    CodecastTrayHeight: tray.height,
  });
}

/** An .icns from a square PNG through an iconset (sips resizes, iconutil packs). */
function makeIcns(pngPath, outPath) {
  const iconset = fs.mkdtempSync(path.join(os.tmpdir(), "appshim-")) + "/app.iconset";
  fs.mkdirSync(iconset);
  try {
    for (const size of ICON_SIZES) {
      for (const scale of [1, 2]) {
        const px = size * scale;
        const file = path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
        execFileSync("sips", ["-s", "format", "png", "-z", String(px), String(px), pngPath, "--out", file], { stdio: "ignore" });
      }
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", outPath]);
  } finally {
    fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
  }
}

function seal(appPath) {
  // Extended attributes (quarantine, Finder info) would fail the seal.
  execFileSync("xattr", ["-cr", appPath]);
  execFileSync("codesign", ["--force", "--sign", "-", "--timestamp=none", appPath], { stdio: "pipe" });
}

const lsregister = (...args) => execFileSync(LSREGISTER, args, { stdio: "ignore" });

/**
 * Installs (or replaces) one app. Builds in a staging directory next to the
 * final path and renames it in, so a half-built bundle is never registered.
 * `appPath` picks the bundle's path (default `<root>/<Name>.app`).
 * Returns {path, bundleId, executable}.
 */
function install(opts) {
  const { slug, name, iconPngPath, shimBinaryPath, root = defaultRoot(), register = true } = opts;
  checkSlug(slug);
  const finalPath = opts.appPath || bundlePath(name, root);
  const staging = path.join(root, `.${path.basename(finalPath)}.${process.pid}.tmp`);
  fs.mkdirSync(root, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  const contents = path.join(staging, "Contents");
  const executable = bundleName(name);
  try {
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
    fs.copyFileSync(shimBinaryPath, path.join(contents, "MacOS", executable));
    fs.chmodSync(path.join(contents, "MacOS", executable), 0o755);
    fs.writeFileSync(path.join(contents, "Info.plist"), infoPlist(opts));
    fs.writeFileSync(path.join(contents, "PkgInfo"), "APPL????");
    makeIcns(iconPngPath, path.join(contents, "Resources", "app.icns"));
    fs.writeFileSync(path.join(contents, "Resources", "client.js"), clientSource());
    seal(staging);
    if (fs.existsSync(finalPath)) uninstall({ appPath: finalPath, register }); // keeps the app's data
    fs.renameSync(staging, finalPath);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  if (register) lsregister("-f", finalPath);
  return { path: finalPath, bundleId: bundleId(slug), executable };
}

/** An installed bundle's Info.plist as an object. */
function readInfo(appPath) {
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(appPath, "Contents", "Info.plist")]).toString());
}

/** Every installed app bundle under `root`: [{path, info}], info being its Info.plist. */
function listBundles(root = defaultRoot()) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith(".app") || name.startsWith(".")) continue;
    const appPath = path.join(root, name);
    try {
      const info = readInfo(appPath);
      if (info.CodecastAppSlug) out.push({ path: appPath, info });
    } catch {}
  }
  return out;
}

/**
 * Puts the current shim binary and page client into an installed bundle and
 * re-seals it (Codecast updated). `plist` sets string keys in its Info.plist
 * first (the host version and seal key that changed with it).
 */
function reseal({ appPath, shimBinaryPath, plist: keys = {}, register = true }) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  for (const [key, value] of Object.entries(keys)) {
    if (value !== undefined && value !== null) execFileSync("plutil", ["-replace", key, "-string", String(value), plistPath]);
  }
  const info = execFileSync("plutil", ["-extract", "CFBundleExecutable", "raw", plistPath]).toString().trim();
  const target = path.join(appPath, "Contents", "MacOS", info);
  fs.copyFileSync(shimBinaryPath, target + ".new");
  fs.chmodSync(target + ".new", 0o755);
  fs.renameSync(target + ".new", target);
  fs.writeFileSync(path.join(appPath, "Contents", "Resources", "client.js"), clientSource());
  seal(appPath);
  if (register) lsregister("-f", appPath);
}

/** Where macOS keeps what one bundle id stores: its WebKit data (the app's own "partition"), caches, cookies, window state. */
const dataPaths = (slug, home = os.homedir()) => {
  const id = bundleId(slug);
  return [
    ["WebKit", id], ["Caches", id], ["HTTPStorages", id], ["HTTPStorages", `${id}.binarycookies`],
    ["Saved Application State", `${id}.savedState`], ["Preferences", `${id}.plist`],
  ].map(([dir, name]) => path.join(home, "Library", dir, name));
};

/**
 * Unregisters and deletes the bundle (`appPath`, or `<root>/<name>.app`; with
 * neither, only the data goes). With
 * `slug`, also removes the app's storage and preferences, which macOS keeps
 * per bundle id outside the bundle.
 */
function uninstall({ appPath: given, name, slug, root = defaultRoot(), register = true, home = os.homedir() }) {
  const appPath = given || (name ? bundlePath(name, root) : null);
  const existed = !!appPath && fs.existsSync(appPath);
  if (existed && register) { try { lsregister("-u", appPath); } catch {} }
  if (appPath) fs.rmSync(appPath, { recursive: true, force: true });
  if (slug) {
    checkSlug(slug);
    // Through cfprefsd first, which would otherwise write its cached copy back over the file.
    if (home === os.homedir()) { try { execFileSync("defaults", ["delete", bundleId(slug)], { stdio: "ignore" }); } catch {} }
    for (const p of dataPaths(slug, home)) fs.rmSync(p, { recursive: true, force: true });
  }
  return existed;
}

module.exports = {
  install, uninstall, reseal, readInfo, listBundles, dataPaths, bundlePath, freeBundlePath, bundleName, bundleId,
  defaultRoot, infoPlist, LSREGISTER,
};
