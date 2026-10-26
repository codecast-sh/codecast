// The storage the app and its notification service extension share for push
// prefetch. This file exists twice on purpose (the app's native module and the
// extension cannot share a pod); prefetch.test.ts keeps the copies identical.
//
// - The access token sits in a keychain group both can read. The app writes it
//   whenever its sign-in changes; the extension only reads it.
// - The app group container holds the backend URL and, per conversation the
//   app has loaded, the newest row it holds (the watermark). The extension
//   reads rows newer than that and leaves them in push-prefetch/, one file per
//   conversation, for the app to merge the next time it opens.

import Foundation
import Security

public enum PushPrefetchStore {
    public static let appGroup = "group.com.ashotp.codecast"
    public static let keychainGroup = "WRG9THCK9Q.com.ashotp.codecast.shared"
    static let service = "sh.codecast.push-prefetch"
    static let tokenAccount = "convex-access-token"

    static var container: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    static var prefetchDir: URL? {
        container?.appendingPathComponent("push-prefetch", isDirectory: true)
    }

    static var stateFile: URL? {
        container?.appendingPathComponent("push-prefetch-state.json")
    }

    static func tokenQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: tokenAccount,
            kSecAttrAccessGroup as String: keychainGroup,
        ]
    }

    /// Replaces the shared token; nil removes it (signed out).
    public static func setToken(_ token: String?) {
        SecItemDelete(tokenQuery() as CFDictionary)
        guard let token, let data = token.data(using: .utf8) else { return }
        var add = tokenQuery()
        add[kSecValueData as String] = data
        // Readable while the phone is locked after its first unlock: pushes
        // arrive on a locked phone.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    public static func token() -> String? {
        var query = tokenQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// The app's state: {"url": backend URL, "watermarks": {conversationId: newest row ms}}.
    public static func writeState(_ json: String) -> Bool {
        guard let file = stateFile, let data = json.data(using: .utf8) else { return false }
        return (try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil
    }

    public static func readState() -> (url: String, watermarks: [String: Double])? {
        guard let file = stateFile, let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let url = object["url"] as? String,
              let marks = object["watermarks"] as? [String: Any] else { return nil }
        var watermarks: [String: Double] = [:]
        for (key, value) in marks {
            if let n = value as? NSNumber { watermarks[key] = n.doubleValue }
        }
        return (url, watermarks)
    }

    /// One file per conversation: a later fetch from the same watermark holds
    /// every row an earlier one did, so it replaces it.
    public static func savePrefetch(conversationId: String, json: Data) {
        guard let dir = prefetchDir, conversationId.allSatisfy({ $0.isLetter || $0.isNumber }) else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? json.write(
            to: dir.appendingPathComponent("\(conversationId).json"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }

    /// Every saved prefetch, removed as it is read.
    public static func takeAll() -> [String] {
        guard let dir = prefetchDir,
              let files = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return [] }
        var out: [String] = []
        for file in files where file.pathExtension == "json" {
            if let data = try? Data(contentsOf: file), let text = String(data: data, encoding: .utf8) {
                out.append(text)
            }
            try? FileManager.default.removeItem(at: file)
        }
        return out
    }
}
