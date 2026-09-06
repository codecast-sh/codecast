// Which image the tray wears, and whether macOS may recolour it (ct-49552).
// No Electron here — main.js turns the answer into a NativeImage.
//
// The tray has two states, and they are the dock badge's two states: idle, and
// "somebody is waiting on you". Both are driven by the one needs-input count
// that arrives over `set-badge-count`, so the badge and the tray cannot
// disagree about whether anything needs you.
//
// Per platform, because the conventions differ:
//
//   macOS wants a monochrome mask. The idle image stays a TEMPLATE image, which
//   is what lets AppKit paint it for a light or a dark menu bar. The attention
//   image is the same glyph filled with --sol-yellow (#b58900, the colour the
//   inbox's Needs Input section already wears) and is NOT a template image:
//   macOS would throw the colour away and paint the mask, leaving the two
//   states identical. That colour was chosen because it holds contrast against
//   a black menu bar and a white one alike, so one file covers both themes.
//
//   Windows and Linux want a colour icon. Idle is the app mark; attention is
//   the app mark wearing an amber dot in the corner. A recoloured glyph would
//   be wrong there — the mark sits on its own light tile, and the panel behind
//   it can be any colour the user picked.
//
// Assets: assets/trayAttention.png is assets/trayTemplate.png with its colour
// channels replaced and its mask untouched; assets/trayColor.png is assets/
// icon.png at 32px; assets/trayColorAttention.png is that plus the dot.

const ICONS = {
  darwin: { idle: "trayTemplate.png", attention: "trayAttention.png" },
  other: { idle: "trayColor.png", attention: "trayColorAttention.png" },
};

// Every tray file that must reach the packaged app. The macOS pair each ship a
// retina companion that AppKit picks by name, so those two never appear in the
// code — and a file no code names is exactly the file an allowlist loses. A
// missing tray image is a blank menu bar mark, not a crash, so nothing else
// would report it. buildFiles.test.js checks this list against build.files.
const TRAY_ASSET_FILES = [
  "assets/trayTemplate.png",
  "assets/trayTemplate@2x.png",
  "assets/trayAttention.png",
  "assets/trayAttention@2x.png",
  "assets/trayColor.png",
  "assets/trayColorAttention.png",
];

// A count from a renderer can be anything; anything that is not a positive
// number means "nothing is waiting".
function attentionCount(count) {
  const n = Math.floor(Number(count));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function trayIconState(count, platform = process.platform) {
  const n = attentionCount(count);
  const set = platform === "darwin" ? ICONS.darwin : ICONS.other;
  return {
    attention: n > 0,
    file: n > 0 ? set.attention : set.idle,
    // Only the macOS idle mark is a mask. See the note above.
    template: platform === "darwin" && n === 0,
    tooltip: n > 0 ? `Codecast · ${n} session${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} input` : "Codecast",
  };
}

module.exports = { trayIconState, TRAY_ASSET_FILES };
