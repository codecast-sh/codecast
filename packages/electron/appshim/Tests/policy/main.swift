import Foundation

// Built with Sources/UrlPolicy.swift by swift.test.js; exits nonzero on a failure.
var failures = 0
func expect(_ ok: Bool, _ label: String) {
    if !ok { failures += 1; print("FAIL: \(label)") }
}
func u(_ s: String) -> URL { URL(string: s)! }

let page = u("https://a.codecast.sh/slug?host=app&k=1")
let nav = { (s: String) in UrlPolicy.navigable(u(s), page: page) }

// Navigation lock
expect(nav("https://a.codecast.sh/slug"), "the page itself")
expect(nav("https://a.codecast.sh/slug?surface=tray#x"), "query and fragment")
expect(nav("https://a.codecast.sh/slug/sub/page"), "under the path")
expect(nav("HTTPS://A.CODECAST.SH/slug/x"), "scheme and host case")
expect(!nav("https://a.codecast.sh/slug-evil"), "sibling path prefix")
expect(!nav("https://a.codecast.sh/slugger/x"), "longer sibling")
expect(!nav("https://a.codecast.sh/other"), "other path, same origin")
expect(!nav("https://a.codecast.sh/slug/../other"), "dot segments out of the path")
expect(!nav("https://a.codecast.sh/slug%2F..%2Fother"), "encoded slash")
expect(!nav("https://evil.example/slug"), "other host")
expect(!nav("https://a.codecast.sh.evil.example/slug"), "host suffix")
expect(!nav("http://a.codecast.sh/slug"), "scheme downgrade")
expect(!nav("https://a.codecast.sh:8443/slug"), "other port")
expect(!nav("file:///Users/x/slug"), "file")
expect(nav("about:blank") && nav("data:text/html,x") && nav("blob:https://a.codecast.sh/1"), "inline documents")
expect(UrlPolicy.navigable(u("https://a.codecast.sh/anything"), page: u("https://a.codecast.sh/")), "root page")
expect(UrlPolicy.navigable(u("http://127.0.0.1:5555/app/x"), page: u("http://127.0.0.1:5555/app/")), "trailing slash base")
expect(!UrlPolicy.navigable(u("http://127.0.0.1:5556/app"), page: u("http://127.0.0.1:5555/app")), "explicit port differs")

// External opener
for ok in ["https://example.com", "http://example.com/x", "mailto:a@b.c", "HTTPS://example.com"] {
    expect(UrlPolicy.canOpenExternally(u(ok)), "opens \(ok)")
}
for bad in ["file:///Applications/Calculator.app", "file:///tmp/x.command", "ssh://host", "vnc://host", "smb://host/share",
            "x-apple.systempreferences:com.apple.preference.security", "javascript:alert(1)", "ftp://host",
            "sh.codecast.desktop://x", "tel:123"] {
    expect(!UrlPolicy.canOpenExternally(u(bad)), "refuses \(bad)")
}

// Bridge gate
let bridge = { (main: Bool, s: String?) in UrlPolicy.bridgeAllows(isMainFrame: main, frameUrl: s.map(u), page: page) }
expect(bridge(true, "https://a.codecast.sh/slug?host=app"), "main frame on the page")
expect(!bridge(false, "https://a.codecast.sh/slug?host=app"), "subframe on the page")
expect(!bridge(true, "https://a.codecast.sh/slug-evil"), "main frame on a sibling path")
expect(!bridge(true, "https://evil.example/slug"), "main frame elsewhere")
expect(!bridge(true, "about:blank"), "about:blank main frame")
expect(!bridge(true, "data:text/html,x"), "data main frame")
expect(!bridge(true, nil), "no URL")

if failures > 0 { exit(1) }
print("ok")
