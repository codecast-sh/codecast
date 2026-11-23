/** @type {import('@bacons/apple-targets/app.plugin').Config} */
// The share extension: "Codecast" in the iOS share sheet for images. It saves
// what was shared into the app group (ShareInbox.swift) and opens the app,
// which starts a new session with those images attached (lib/shareInbox.ts).
// Info.plist beside this file holds the activation rule: images only, up to
// the six a message's picker allows.
module.exports = {
  type: 'share',
  name: 'CodecastShare',
  displayName: 'Codecast',
  bundleIdentifier: '.share',
  deploymentTarget: '16.0',
  entitlements: {
    'com.apple.security.application-groups': ['group.com.ashotp.codecast'],
  },
};
