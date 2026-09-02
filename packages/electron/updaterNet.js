// Network layer for the self-contained desktop updater (see main.js): the
// redirect-following GET, the feed fetch, and the resumable download with its
// connect and read-inactivity timeouts.
//
// The code moved to @platform/desktop, byte for byte what this file used to
// hold, so the shell and any other app on that package share one downloader
// and one set of hard-won timeout rules. This file stays as the module main.js
// requires: the require path does not move, and neither does the entry
// build.files already allows into the packaged app.
//
// Exports getFollow, fetchText and downloadResumable, unchanged.

module.exports = require("@platform/desktop").updaterNet;
