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
for s in [HostState.missing, .notRunning, .signedOut, .offline, .pageFailed] { expect(!s.title.isEmpty, "\(s) has a title") }
expect(HostState.offline.action == "Try Again" && HostState.pageFailed.action == "Try Again", "a failed load offers a retry")

// A failed page load: no connection, another failure, or a load that was only cancelled.
expect(HostState.pageLoad(errorDomain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet) == .offline, "no connection")
expect(HostState.pageLoad(errorDomain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost) == .pageFailed, "server down")
expect(HostState.pageLoad(errorDomain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost) == .pageFailed, "a dropped connection is not offline")
expect(HostState.pageLoad(errorDomain: NSURLErrorDomain, code: NSURLErrorCancelled) == nil, "cancelled is not a failure")
expect(HostState.pageLoad(errorDomain: "WebKitErrorDomain", code: 102) == nil, "a refused navigation is not a failure")
expect(HostState.cover(host: .notRunning, page: .offline) == .notRunning, "Codecast's state comes first")
expect(HostState.cover(host: .ready, page: .offline) == .offline, "then the page's")
expect(HostState.cover(host: .ready, page: nil) == .ready, "nothing wrong, no cover")

expect(ShimText.displayAddress(URL(string: "https://a.codecast.sh/vitals?host=app&k=secret#x")!) == "https://a.codecast.sh/vitals",
       "the About address drops the gate keys")
expect(ShimText.opaqueCssColor("rgb(15, 20, 25)") == [15.0 / 255, 20.0 / 255, 25.0 / 255], "a page color")
expect(ShimText.opaqueCssColor("rgba(0, 0, 0, 0)") == nil, "no background is not a color")
expect(ShimText.opaqueCssColor("rgba(10, 10, 10, 0.5)") == nil, "a see-through background is not the page's color")
expect(ShimText.opaqueCssColor("color(srgb 1 0 0)") == nil, "an unreadable color is skipped")
expect(ShimText.settingsLink(slug: "k3j2h4").absoluteString == "codecast://open/settings/installed-apps?app=k3j2h4", "settings link")
expect(ShimText.zoom(from: 1, by: 1) == 1.1 && ShimText.zoom(from: 1, by: -1) == 0.9, "zoom steps")
expect(ShimText.zoom(from: 3, by: 1) == 3 && ShimText.zoom(from: 0.5, by: -1) == 0.5, "zoom stops at the ends")
expect(ShimText.zoom(from: 1.75, by: 0) == 1, "actual size")
expect(HostState.ready.title.isEmpty, "ready shows nothing")

let ua = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) " + ShimText.userAgentSuffix(hostVersion: "1.1.131", slug: "k3j2h4")
expect(ua.hasSuffix(" CodecastApp/1.1.131 (k3j2h4)"), "user agent ends the way the server matches")
expect(ShimText.notificationSettingsUrl(bundleId: "sh.codecast.app.k3j2h4")
    == "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=sh.codecast.app.k3j2h4", "settings link")
expect(ShimText.notificationStatus(1) == "denied" && ShimText.notificationStatus(2) == "authorized"
    && ShimText.notificationStatus(0) == "not-determined", "notification statuses")

if failures > 0 { exit(1) }
print("ok")
