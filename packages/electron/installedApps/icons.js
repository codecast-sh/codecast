// An installed app's icons, made from the page's icon PNG
// (appInfo `icons["1024"]`, docs/architecture/installed-apps.md "Icon").
//
//   icon.png          the icon as served (any size; the host scales it)
//   icon.ico          Windows: taskbar, Start menu shortcut, window icon.
//                     PNG-compressed entries at 16, 24, 32, 48, 64 and 256 px,
//                     which every Windows since Vista reads.
//   tray.png, tray@2x.png
//                     the tray item: the declared tray.icon when the page has
//                     one, else drawn from the app icon. On macOS it is a
//                     template image: a dot whose ink is the icon's dark parts,
//                     so a monogram tile becomes a dot with its letter cut out.
//
// The encoders are pure (Buffers and BGRA bitmaps in, Buffers out). Scaling is
// handed in (`imaging`, from Electron's nativeImage in main), so this file
// stays testable under plain node.
const fs = require("node:fs");
const path = require("node:path");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO_SIZES = [16, 24, 32, 48, 64, 256];
const TRAY_SIZE = 16;
const MAX_ICON_BYTES = 8 * 1024 * 1024;

const isPng = (buf) => Buffer.isBuffer(buf) && buf.length > 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE);

/** A PNG's pixel size from its IHDR chunk. */
function pngSize(buf) {
  if (!isPng(buf) || buf.toString("latin1", 12, 16) !== "IHDR") throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * An .ico holding each PNG as its own entry (PNG-in-ICO). `pngs` are PNG
 * Buffers of square images up to 256 px; a 256 px entry's size bytes are 0, as
 * the format says.
 */
function pngToIco(pngs) {
  if (!pngs.length) throw new Error("an .ico needs at least one image");
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  const entries = Buffer.alloc(16 * pngs.length);
  let offset = header.length + entries.length;
  pngs.forEach((png, i) => {
    const { width, height } = pngSize(png);
    if (width > 256 || height > 256) throw new Error(`an .ico entry is at most 256 px, got ${width}x${height}`);
    const at = i * 16;
    entries.writeUInt8(width === 256 ? 0 : width, at);
    entries.writeUInt8(height === 256 ? 0 : height, at + 1);
    entries.writeUInt8(0, at + 2); // palette colors
    entries.writeUInt8(0, at + 3); // reserved
    entries.writeUInt16LE(1, at + 4); // color planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...pngs]);
}

/**
 * A macOS tray template drawn from the app icon: black ink inside a circle,
 * as opaque as the icon is dark there. `bgra` is a size x size BGRA bitmap
 * (nativeImage.toBitmap); the result is the same shape.
 */
function templateFromIcon(bgra, size) {
  const out = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dist = Math.hypot(x - c, y - c);
      // A soft edge one pixel wide keeps the dot round at 16 px.
      const inside = Math.max(0, Math.min(1, r - dist));
      const alpha = bgra[i + 3] / 255;
      const luma = (0.0722 * bgra[i] + 0.7152 * bgra[i + 1] + 0.2126 * bgra[i + 2]) / 255;
      const ink = Math.round(255 * inside * alpha * Math.min(1, (1 - luma) * 1.6));
      out[i + 3] = ink; // B, G, R stay 0: black ink
    }
  }
  return out;
}

/** Scaling and bitmaps through Electron's nativeImage. */
function nativeImaging(nativeImage) {
  const scaled = (png, size) => nativeImage.createFromBuffer(png).resize({ width: size, height: size, quality: "best" });
  return {
    resize: (png, size) => scaled(png, size).toPNG(),
    bitmap: (png, size) => scaled(png, size).toBitmap(),
    fromBitmap: (bgra, size) => nativeImage.createFromBitmap(bgra, { width: size, height: size }).toPNG(),
  };
}

/** GETs a PNG, refusing anything that is not one or that is too large. */
async function fetchPng(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`icon fetch answered ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ICON_BYTES) throw new Error("icon is larger than 8 MB");
  if (!isPng(buf)) throw new Error("icon is not a PNG");
  return buf;
}

/**
 * Writes the icon set for one app into `dir` and returns the paths:
 * {png, ico?, tray, tray2x}. `trayPng` is the declared tray icon, or null to
 * draw one from the app icon.
 */
function writeIconSet({ dir, png, trayPng = null, platform = process.platform, imaging }) {
  fs.mkdirSync(dir, { recursive: true });
  const out = { png: path.join(dir, "icon.png") };
  fs.writeFileSync(out.png, png);
  if (platform === "win32") {
    out.ico = path.join(dir, "icon.ico");
    fs.writeFileSync(out.ico, pngToIco(ICO_SIZES.map((s) => imaging.resize(png, s))));
  }
  out.tray = path.join(dir, "tray.png");
  out.tray2x = path.join(dir, "tray@2x.png");
  for (const [file, size] of [[out.tray, TRAY_SIZE], [out.tray2x, TRAY_SIZE * 2]]) {
    let image;
    if (trayPng) image = imaging.resize(trayPng, size);
    else if (platform === "darwin") image = imaging.fromBitmap(templateFromIcon(imaging.bitmap(png, size), size), size);
    else image = imaging.resize(png, size);
    fs.writeFileSync(file, image);
  }
  // Whether nativeImage should treat tray.png as a template (macOS only).
  out.trayTemplate = platform === "darwin";
  return out;
}

module.exports = { pngToIco, pngSize, isPng, templateFromIcon, nativeImaging, fetchPng, writeIconSet, ICO_SIZES };
