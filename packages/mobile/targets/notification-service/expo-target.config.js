/** @type {import('@bacons/apple-targets/app.plugin').Config} */
// The notification service extension: iOS hands it every push flagged
// mutable-content (the server flags pushes about a conversation) before
// showing it. It reads that conversation's new rows into the app group so
// opening the push shows them at once; the push itself is shown unchanged,
// and on any failure or timeout it is shown as it came.
module.exports = {
  type: 'notification-service',
  name: 'CodecastNotificationService',
  bundleIdentifier: '.notification-service',
  deploymentTarget: '16.0',
  entitlements: {
    'com.apple.security.application-groups': ['group.com.ashotp.codecast'],
    'keychain-access-groups': ['$(AppIdentifierPrefix)com.ashotp.codecast.shared'],
  },
};
