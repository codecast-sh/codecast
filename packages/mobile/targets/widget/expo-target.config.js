/** @type {import('@bacons/apple-targets/app.plugin').Config} */
// The widget extension that renders the Lock Screen Live Activity. The views
// live beside this file; the wire struct is CodecastActivityAttributes.swift,
// a byte-identical copy of the app module's (see the note in that file).
module.exports = {
  type: 'widget',
  name: 'CodecastWidget',
  displayName: 'Codecast',
  bundleIdentifier: '.widget',
  // ActivityKit rendering needs 16.2; the app itself targets 16.0 and simply
  // ships no strip on 16.0 / 16.1.
  deploymentTarget: '16.2',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
  colors: {
    $accent: '#b58900',
    $widgetBackground: '#002b36',
  },
};
