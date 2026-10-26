import CoreGraphics
import Foundation

/// One capture of a window's pixels, kept only long enough to compare.
public struct PixelFrame {
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int
    public let bytesPerPixel: Int
    /// Window points per pixel, so a changed region is reported in the
    /// coordinates an action takes.
    public let pointsPerPixel: Double
    public let bytes: Data

    public init(width: Int, height: Int, bytesPerRow: Int, bytesPerPixel: Int, pointsPerPixel: Double, bytes: Data) {
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.bytesPerPixel = bytesPerPixel
        self.pointsPerPixel = pointsPerPixel
        self.bytes = bytes
    }
}

/// What a window's pixels did across an action.
///
/// The tree misses whatever an app draws itself (a canvas, a terminal, a
/// drawing), so a press that changed only pixels used to read as "no change"
/// and cost the agent a screenshot to settle. The CLI decides what the regions
/// mean.
public enum PixelChange {
    /// How long after the second capture the third one is taken. Long enough
    /// for a spinner or a clock to move, short enough to add little to an
    /// action that changed something.
    public static let repaintProbeMicroseconds: UInt32 = 150_000

    /// Two captures of a window that did not change are not byte identical:
    /// the window server's compositing leaves channel values a few steps apart
    /// (measured up to 7 on an unchanged white canvas), while anything a person
    /// would call a change, antialiased text included, moves a channel by tens.
    public static let channelTolerance: UInt8 = 8

    /// The window's rounded corners are left out: their antialiased edge
    /// pixels repaint when the window becomes main or key, which the helper
    /// itself causes before keyboard input, so they changed on every action.
    public static let cornerPoints: Double = 16

    /// The bounding box of the pixels that differ, in window points, or nil
    /// when the frames are the same. A resized window differs everywhere.
    public static func changedRect(_ a: PixelFrame, _ b: PixelFrame) -> CGRect? {
        guard a.width == b.width, a.height == b.height, a.bytesPerPixel == b.bytesPerPixel,
              a.bytes.count >= a.bytesPerRow * a.height, b.bytes.count >= b.bytesPerRow * b.height
        else {
            let width = Double(max(a.width, b.width)) * b.pointsPerPixel
            let height = Double(max(a.height, b.height)) * b.pointsPerPixel
            return CGRect(x: 0, y: 0, width: width.rounded(.up), height: height.rounded(.up))
        }
        let rowBytes = a.width * a.bytesPerPixel
        let corner = Int((cornerPoints / max(a.pointsPerPixel, 0.01)).rounded(.up))
        var minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
        a.bytes.withUnsafeBytes { (pa: UnsafeRawBufferPointer) in
            b.bytes.withUnsafeBytes { (pb: UnsafeRawBufferPointer) in
                let ra = pa.bindMemory(to: UInt8.self), rb = pb.bindMemory(to: UInt8.self)
                for y in 0..<a.height {
                    let oa = y * a.bytesPerRow, ob = y * b.bytesPerRow
                    if memcmp(ra.baseAddress! + oa, rb.baseAddress! + ob, rowBytes) == 0 { continue }
                    let bpp = a.bytesPerPixel
                    let cornerRow = y < corner || y >= a.height - corner
                    func differs(_ x: Int) -> Bool {
                        if cornerRow && (x < corner || x >= a.width - corner) { return false }
                        for c in 0..<bpp {
                            let p = ra[oa + x * bpp + c], q = rb[ob + x * bpp + c]
                            if (p > q ? p - q : q - p) > channelTolerance { return true }
                        }
                        return false
                    }
                    guard let first = (0..<a.width).first(where: differs) else { continue }
                    let last = (first..<a.width).last(where: differs)!
                    minX = min(minX, first)
                    maxX = max(maxX, last)
                    minY = min(minY, y)
                    maxY = y
                }
            }
        }
        guard maxY >= 0 else { return nil }
        let scale = a.pointsPerPixel
        let x0 = (Double(minX) * scale).rounded(.down), y0 = (Double(minY) * scale).rounded(.down)
        let x1 = (Double(maxX + 1) * scale).rounded(.up), y1 = (Double(maxY + 1) * scale).rounded(.up)
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    public static func json(_ rect: CGRect?) -> Any {
        guard let rect else { return NSNull() }
        return ["x": Int(rect.minX), "y": Int(rect.minY), "width": Int(rect.width), "height": Int(rect.height)]
    }
}
