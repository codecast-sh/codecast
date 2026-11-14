import Foundation

/// Where a window picture goes: a file the helper writes, never bytes in the
/// reply. Base64 inside a JSON line made a Finder capture 600 KB of text that
/// crossed the socket, was parsed, decoded and written again by the CLI.
///
/// The directory is the CLI's (`$TMPDIR/codecast-computer`, 0700, swept after a
/// day by the CLI), passed in each request so both ends agree on it. A capture
/// can hold anything that was on screen, so the rules match the CLI's own:
/// the directory must be a real directory this uid owns (a symlink planted at
/// its name is refused, never followed) and the file is 0600.
public enum ScreenshotFile {
    public enum Failure: Error, CustomStringConvertible {
        case notAbsolute(String)
        case notADirectory(String)
        case wrongOwner(String, uid: uid_t)

        public var description: String {
            switch self {
            case let .notAbsolute(path): return "\(path) is not an absolute path"
            case let .notADirectory(path): return "\(path) is not a directory"
            case let .wrongOwner(path, uid): return "\(path) is owned by uid \(uid), not \(getuid())"
            }
        }
    }

    public static let suffix = "-screenshot.png"

    public static func defaultDirectory() -> String {
        (NSTemporaryDirectory() as NSString).appendingPathComponent("codecast-computer")
    }

    /// The snapshot id names the file; nothing in it may leave the directory.
    /// Same rule as the CLI's `screenshotFileName`.
    public static func fileName(snapshotId: String) -> String {
        var safe = String(snapshotId.unicodeScalars.map { scalar -> Character in
            let c = Character(scalar)
            return (c.isASCII && (c.isLetter || c.isNumber)) || c == "." || c == "_" || c == "-" ? c : "-"
        })
        while safe.hasPrefix(".") { safe.removeFirst() }
        safe = String(safe.prefix(96))
        return (safe.isEmpty ? "snapshot" : safe) + suffix
    }

    /// Create the directory 0700 if needed and prove it is ours.
    public static func ensureDirectory(_ directory: String) throws {
        guard directory.hasPrefix("/") else { throw Failure.notAbsolute(directory) }
        try? FileManager.default.createDirectory(
            atPath: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
        )
        var info = stat()
        guard lstat(directory, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
            throw Failure.notADirectory(directory)
        }
        guard info.st_uid == getuid() else { throw Failure.wrongOwner(directory, uid: info.st_uid) }
        chmod(directory, 0o700)
    }

    /// Write the picture and return its absolute path.
    public static func write(_ data: Data, directory: String, snapshotId: String) throws -> String {
        try ensureDirectory(directory)
        let path = (directory as NSString).appendingPathComponent(fileName(snapshotId: snapshotId))
        try PrivateFileWrite.write(data, to: path)
        return path
    }
}
