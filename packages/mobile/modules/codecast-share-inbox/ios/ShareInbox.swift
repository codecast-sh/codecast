// Where the share extension leaves images for the app. This file exists twice
// on purpose (the app's native module and the extension cannot share a pod);
// shareInbox.test.ts keeps the copies identical.
//
// The extension writes each shared image into share-inbox/ in the app group
// container, named so a directory listing is the order they were shared in.
// The app takes them the next time it is active: each file moves into the
// app's own temporary directory, so nothing is ever taken twice and iOS
// clears them once they have been uploaded.

import Foundation

public enum ShareInbox {
    public static let appGroup = "group.com.ashotp.codecast"

    static var dir: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("share-inbox", isDirectory: true)
    }

    /// Saves one shared image; `batch` and `index` keep the shared order.
    @discardableResult
    public static func save(_ data: Data, ext: String, batch: Int, index: Int) -> Bool {
        guard let dir else { return false }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            // Atomic: the app never lists a half-written file.
            try data.write(to: dir.appendingPathComponent("\(batch)-\(index).\(ext)"), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    /// Moves every waiting image out of the inbox; returns their file URLs.
    public static func takeAll() -> [String] {
        let fm = FileManager.default
        guard let dir, let waiting = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil),
              !waiting.isEmpty else { return [] }
        let taken = fm.temporaryDirectory.appendingPathComponent("share-inbox", isDirectory: true)
        try? fm.createDirectory(at: taken, withIntermediateDirectories: true)
        return waiting
            .sorted { $0.lastPathComponent.compare($1.lastPathComponent, options: .numeric) == .orderedAscending }
            .compactMap { file in
                let to = taken.appendingPathComponent(file.lastPathComponent)
                try? fm.removeItem(at: to)
                guard (try? fm.moveItem(at: file, to: to)) != nil else { return nil }
                return to.absoluteString
            }
    }
}
