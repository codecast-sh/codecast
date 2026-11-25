import Foundation

// Built with Sources/HostState.swift by swift.test.js; exits nonzero on a failure.
var failures = 0
func expect(_ ok: Bool, _ label: String) {
    if !ok { failures += 1; print("FAIL: \(label)") }
}

expect(HostState.from(event: ["signedIn": false]) == .signedOut, "signed out event")
expect(HostState.from(event: ["signedIn": true]) == .ready, "signed in event")
expect(HostState.from(event: NSNull()) == .ready, "an event without the field leaves the app usable")
expect(HostState.missing.action == "Get Codecast", "missing offers the download")
expect(HostState.notRunning.action == "Open Codecast" && HostState.signedOut.action == "Open Codecast", "others open Codecast")
expect(HostState.signedOut.detail(app: "Vitals").contains("Vitals"), "detail names the app")
for s in [HostState.missing, .notRunning, .signedOut] { expect(!s.title.isEmpty, "\(s) has a title") }
expect(HostState.ready.title.isEmpty, "ready shows nothing")

let ua = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) " + ShimText.userAgentSuffix(hostVersion: "1.1.131", slug: "k3j2h4")
expect(ua.hasSuffix(" CodecastApp/1.1.131 (k3j2h4)"), "user agent ends the way the server matches")
expect(ShimText.notificationSettingsUrl(bundleId: "sh.codecast.app.k3j2h4")
    == "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=sh.codecast.app.k3j2h4", "settings link")
expect(ShimText.notificationStatus(1) == "denied" && ShimText.notificationStatus(2) == "authorized"
    && ShimText.notificationStatus(0) == "not-determined", "notification statuses")

if failures > 0 { exit(1) }
print("ok")
