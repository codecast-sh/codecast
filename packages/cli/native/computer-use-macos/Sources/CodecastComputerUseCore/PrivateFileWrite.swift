import Foundation

/// Files the helper writes for the CLI to read back, owner-only.
///
/// `String.write(toFile:atomically:)` creates its file with whatever the umask
/// leaves, which is 0644 on a default Mac — world readable. Every other file in
/// the design is 0600 or 0700, and the permission status the CLI reads is no
/// different: it says what this Mac has granted, and it belongs to the user who
/// asked for it (ct-49615). So the mode is set explicitly, never inherited.
public enum PrivateFileWrite {
    public enum Failure: Error, CustomStringConvertible {
        case couldNotCreate(String)
        case couldNotPublish(String, errno: Int32)

        public var description: String {
            switch self {
            case let .couldNotCreate(path):
                return "could not create \(path)"
            case let .couldNotPublish(path, errno):
                return "could not put the file at \(path) (errno \(errno))"
            }
        }
    }

    /// Write `text` to `path` at mode 0600, replacing whatever is there.
    ///
    /// The bytes land in a sibling temporary first and are renamed onto the
    /// target, so a reader sees either the previous content or the new one and
    /// never a half written file. The rename carries the temporary's own mode,
    /// which is how a target left at 0644 by an older helper ends up 0600.
    public static func write(_ text: String, to path: String) throws {
        let directory = (path as NSString).deletingLastPathComponent
        let temporary = (directory.isEmpty ? "." : directory)
            .appending("/.\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(
            atPath: temporary,
            contents: Data(text.utf8),
            attributes: [.posixPermissions: NSNumber(value: Int16(0o600))]
        ) else {
            throw Failure.couldNotCreate(temporary)
        }
        guard rename(temporary, path) == 0 else {
            let failure = errno
            try? FileManager.default.removeItem(atPath: temporary)
            throw Failure.couldNotPublish(path, errno: failure)
        }
    }
}
