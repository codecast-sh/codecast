import CoreGraphics
import Darwin
import Foundation
@testable import CodecastComputerUseCore
import XCTest

final class ScreenshotFileTests: XCTestCase {
    private var root = ""

    override func setUpWithError() throws {
        root = NSTemporaryDirectory().appending("codecast-shot-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: root)
    }

    private func mode(of path: String) throws -> Int {
        ((try FileManager.default.attributesOfItem(atPath: path))[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    func testWritesOwnerOnlyInsideAnOwnerOnlyDirectory() throws {
        let directory = root + "/codecast-computer"
        let path = try ScreenshotFile.write(Data([1, 2, 3]), directory: directory, snapshotId: "ABC-123")
        XCTAssertEqual(path, directory + "/ABC-123-screenshot.png")
        XCTAssertEqual(try mode(of: path), 0o600)
        XCTAssertEqual(try mode(of: directory), 0o700)
        XCTAssertEqual(FileManager.default.contents(atPath: path), Data([1, 2, 3]))
    }

    func testRefusesASymlinkWhereTheDirectoryShouldBe() throws {
        let target = root + "/elsewhere"
        try FileManager.default.createDirectory(atPath: target, withIntermediateDirectories: true)
        let link = root + "/codecast-computer"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: target)
        XCTAssertThrowsError(try ScreenshotFile.write(Data([1]), directory: link, snapshotId: "x"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target), [])
    }

    func testRefusesARelativeDirectory() {
        XCTAssertThrowsError(try ScreenshotFile.write(Data([1]), directory: "shots", snapshotId: "x"))
    }

    func testANameCannotTraverseOutOfTheDirectory() {
        XCTAssertEqual(ScreenshotFile.fileName(snapshotId: "../../etc/passwd"), "-..-etc-passwd-screenshot.png")
        XCTAssertEqual(ScreenshotFile.fileName(snapshotId: "...hidden"), "hidden-screenshot.png")
        XCTAssertEqual(ScreenshotFile.fileName(snapshotId: ""), "snapshot-screenshot.png")
    }

    func testModelScaleKeepsSmallWindowsWholeAndShrinksLargeOnesToTheBudget() {
        XCTAssertEqual(ScreenshotBoundPolicy.modelScale(width: 800, height: 600), 1)
        let finder = ScreenshotBoundPolicy.modelScale(width: 1512, height: 950)
        XCTAssertEqual(1512 * finder * 950 * finder, ScreenshotBoundPolicy.modelPixels, accuracy: 1)
        // A wide strip is bound by its long edge, not its area.
        XCTAssertEqual(ScreenshotBoundPolicy.modelScale(width: 3136, height: 200), 0.5, accuracy: 1e-9)
    }

    func testCropClampsToTheWindowAndMapsToPixels() {
        let size = CGSize(width: 400, height: 300)
        XCTAssertEqual(ScreenshotCrop.clamp(CGRect(x: 350, y: 250, width: 100, height: 100), to: size), CGRect(x: 350, y: 250, width: 50, height: 50))
        XCTAssertNil(ScreenshotCrop.clamp(CGRect(x: 500, y: 0, width: 10, height: 10), to: size))
        XCTAssertNil(ScreenshotCrop.clamp(CGRect(x: 0, y: 0, width: 0, height: 10), to: size))
        XCTAssertEqual(
            ScreenshotCrop.pixelRect(CGRect(x: 10.25, y: 20, width: 30, height: 40), pixelsPerPoint: 2, imageWidth: 800, imageHeight: 600),
            CGRect(x: 20, y: 40, width: 61, height: 80)
        )
    }
}
