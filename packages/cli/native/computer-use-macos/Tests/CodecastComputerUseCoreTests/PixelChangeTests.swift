import CoreGraphics
import XCTest
@testable import CodecastComputerUseCore

final class PixelChangeTests: XCTestCase {
    private func frame(_ width: Int, _ height: Int, scale: Double = 1, padding: Int = 0, paint: [(Int, Int)] = [], ink: UInt8 = 0, paddingByte: UInt8 = 255) -> PixelFrame {
        let bytesPerRow = width * 4 + padding
        var bytes = [UInt8](repeating: 255, count: bytesPerRow * height)
        for (x, y) in paint {
            bytes[y * bytesPerRow + x * 4] = ink
        }
        if padding > 0 { bytes[width * 4] = paddingByte }
        return PixelFrame(width: width, height: height, bytesPerRow: bytesPerRow, bytesPerPixel: 4, pointsPerPixel: scale, bytes: Data(bytes))
    }

    func testIdenticalFramesHaveNoChange() {
        XCTAssertNil(PixelChange.changedRect(frame(20, 10), frame(20, 10)))
    }

    func testChangedPixelsAreBoundedInPoints() {
        let rect = PixelChange.changedRect(frame(60, 40), frame(60, 40, paint: [(23, 22), (27, 25)]))
        XCTAssertEqual(rect, CGRect(x: 23, y: 22, width: 5, height: 4))
    }

    func testRetinaPixelsConvertToPoints() {
        let rect = PixelChange.changedRect(frame(100, 80, scale: 0.5), frame(100, 80, scale: 0.5, paint: [(40, 40), (41, 41)]))
        XCTAssertEqual(rect, CGRect(x: 20, y: 20, width: 1, height: 1))
    }

    func testRowPaddingIsIgnored() {
        XCTAssertNil(PixelChange.changedRect(frame(8, 4, padding: 16), frame(8, 4, padding: 16, paddingByte: 7)))
    }

    func testCompositingNoiseIsNotAChange() {
        XCTAssertNil(PixelChange.changedRect(frame(60, 40), frame(60, 40, paint: [(20, 20), (40, 21)], ink: 248)))
        XCTAssertEqual(PixelChange.changedRect(frame(60, 40), frame(60, 40, paint: [(20, 20), (25, 21)], ink: 246)), CGRect(x: 20, y: 20, width: 6, height: 2))
    }

    func testRoundedCornersAreLeftOut() {
        XCTAssertNil(PixelChange.changedRect(frame(60, 40), frame(60, 40, paint: [(1, 1), (58, 1), (2, 38), (59, 39)])))
        XCTAssertEqual(PixelChange.changedRect(frame(60, 40), frame(60, 40, paint: [(1, 1), (30, 20)])), CGRect(x: 30, y: 20, width: 1, height: 1))
        XCTAssertEqual(PixelChange.changedRect(frame(60, 40), frame(60, 40, paint: [(1, 20)])), CGRect(x: 1, y: 20, width: 1, height: 1))
    }

    func testResizedWindowChangesEverywhere() {
        XCTAssertEqual(PixelChange.changedRect(frame(20, 10), frame(30, 10)), CGRect(x: 0, y: 0, width: 30, height: 10))
    }
}
