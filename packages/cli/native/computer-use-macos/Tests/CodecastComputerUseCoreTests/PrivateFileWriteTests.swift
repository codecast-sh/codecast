import Darwin
import Foundation
@testable import CodecastComputerUseCore
import XCTest

final class PrivateFileWriteTests: XCTestCase {
    private var directory = ""
    private var previousMask: mode_t = 0

    override func setUpWithError() throws {
        directory = NSTemporaryDirectory().appending("codecast-private-write-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        // A permissive umask masks nothing off, so a file that ends up 0600
        // here got its mode set explicitly rather than by luck of the shell
        // that launched the helper.
        previousMask = umask(0)
    }

    override func tearDownWithError() throws {
        umask(previousMask)
        try? FileManager.default.removeItem(atPath: directory)
    }

    private func mode(of path: String) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    func testWritesTheFileOwnerOnly() throws {
        let path = directory.appending("/permission-status.json")

        try PrivateFileWrite.write(#"{"accessibility":"granted"}"#, to: path)

        XCTAssertEqual(try mode(of: path), 0o600)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), #"{"accessibility":"granted"}"#)
    }

    func testTightensAFileAnOlderHelperLeftWorldReadable() throws {
        let path = directory.appending("/permission-status.json")
        FileManager.default.createFile(
            atPath: path,
            contents: Data("stale".utf8),
            attributes: [.posixPermissions: NSNumber(value: Int16(0o644))]
        )

        try PrivateFileWrite.write("fresh", to: path)

        XCTAssertEqual(try mode(of: path), 0o600)
        XCTAssertEqual(try String(contentsOfFile: path, encoding: .utf8), "fresh")
    }

    func testLeavesNoTemporaryBehind() throws {
        try PrivateFileWrite.write("x", to: directory.appending("/permission-status.json"))

        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: directory).sorted(),
            ["permission-status.json"]
        )
    }

    func testReportsAPathItCannotWrite() {
        XCTAssertThrowsError(try PrivateFileWrite.write("x", to: "/nonexistent-directory/status.json"))
    }
}
