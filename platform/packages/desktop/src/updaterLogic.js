// Pure decisions for the self-contained desktop updater. No Electron, no
// network, no filesystem — main.js and the tests both call these.
//
// The update flow (see README, "The auto update flow"):
//   feed url for a channel → parse the feed → compare versions → decide whether
//   to download, and whether a staged bundle must be applied right now because
//   the installed version sits below the server pinned floor (the kill switch).

// Numeric, segment by segment. "1.1.10" > "1.1.9"; missing segments are 0.
function cmpVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// electron-builder's generic provider publishes one feed per channel:
// latest-mac.yml for the default channel, <channel>-mac.yml otherwise.
function feedFileName(channel = "latest", platform = "mac") {
  const c = String(channel || "latest").trim().toLowerCase() || "latest";
  return `${c}-${platform}.yml`;
}

function feedUrlFor(baseUrl, channel, platform) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${feedFileName(channel, platform)}`;
}

// Parse only the fields we need from latest-mac.yml (no YAML dependency).
function parseFeed(text) {
  const version = text.match(/^version:\s*(.+)$/m)?.[1]?.trim();
  let zip, sha512;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/url:\s*(\S+-mac\.zip)\s*$/);
    if (m) {
      zip = m[1].trim();
      const sm = lines[i + 1]?.match(/sha512:\s*(\S+)\s*$/);
      if (sm) sha512 = sm[1].trim();
      break;
    }
  }
  return { version, zip, sha512 };
}

// Whether a feed entry is worth downloading. `force` re-downloads the current
// version (a manual reinstall); otherwise only a strictly newer version counts.
function shouldDownload({ feedVersion, installedVersion, force = false }) {
  if (!feedVersion) return false;
  if (force) return true;
  return cmpVersions(feedVersion, installedVersion) > 0;
}

// The kill switch. When the server's minimum version is above the installed
// one, a staged update is applied without waiting for "Restart now". A missing
// or malformed floor never forces anything.
function mustApplyNow({ installedVersion, minVersion }) {
  if (!minVersion || typeof minVersion !== "string") return false;
  if (!/^\d+(\.\d+)*$/.test(minVersion.trim())) return false;
  return cmpVersions(installedVersion, minVersion.trim()) < 0;
}

// One decision for one check. Returns what the runtime should do next:
//   { action: "skip" | "download", reason }
function decideUpdate({ feed, installedVersion, force = false, platform = "darwin", packaged = true }) {
  if (platform !== "darwin" || !packaged) return { action: "skip", reason: "unsupported" };
  if (!feed || !feed.version || !feed.zip || !feed.sha512) return { action: "skip", reason: "bad-feed" };
  if (!shouldDownload({ feedVersion: feed.version, installedVersion, force })) {
    return { action: "skip", reason: "up-to-date" };
  }
  return { action: "download", reason: force ? "forced" : "newer" };
}

// The swap helper: a /bin/sh script that waits for `pid` to exit, renames the
// old bundle aside, renames the incoming one in, rolls back if either rename
// fails, clears quarantine, removes the old bundle and reopens the app in the
// foreground. Pure string so the quoting and the rollback are testable.
function swapScript({ pid, bundlePath, incomingPath, oldPath }) {
  const sh = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`; // single-quote for /bin/sh
  return [
    `while kill -0 ${pid} 2>/dev/null; do sleep 0.2; done`,
    `rm -rf ${sh(oldPath)}`,
    `mv ${sh(bundlePath)} ${sh(oldPath)} && mv ${sh(incomingPath)} ${sh(bundlePath)} || { mv ${sh(oldPath)} ${sh(bundlePath)} 2>/dev/null; exit 1; }`,
    `/usr/bin/xattr -dr com.apple.quarantine ${sh(bundlePath)} 2>/dev/null`,
    `rm -rf ${sh(oldPath)}`,
    `/usr/bin/open ${sh(bundlePath)}`,
  ].join("\n");
}

module.exports = {
  cmpVersions,
  feedFileName,
  feedUrlFor,
  parseFeed,
  shouldDownload,
  mustApplyNow,
  decideUpdate,
  swapScript,
};
