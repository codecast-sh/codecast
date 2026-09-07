import Foundation

/// A window picture must fit in a prompt. Over the cap the longest edge scales
/// to 1280, and every retry after that shaves another 15 percent, stopping at a
/// quarter size. The first result inside the cap wins; if nothing fits, the
/// smallest one produced is still worth returning, because a small picture beats
/// a failed command.
public enum ScreenshotBoundPolicy {
    public static let maxBytes = 900_000
    public static let longestEdge: Double = 1280
    public static let scaleStep = 0.85
    public static let minimumScale = 0.25

    public static func fits(_ byteCount: Int) -> Bool {
        byteCount <= maxBytes
    }

    public static func initialScale(width: Int, height: Int) -> Double {
        min(1, longestEdge / Double(max(max(width, height), 1)))
    }

    /// The scales tried, in order, for an image that starts over the cap.
    public static func scaleSequence(width: Int, height: Int) -> [Double] {
        var scale = initialScale(width: width, height: height)
        var scales: [Double] = []
        while scale >= minimumScale {
            scales.append(scale)
            scale *= scaleStep
        }
        return scales
    }
}

/// Clipboard payloads are bounded before anything reaches the pasteboard, so a
/// runaway paste cannot wedge the helper or the human's clipboard.
public enum PasteSafety {
    public static let maxBytes = 16 * 1024 * 1024
    public static let tooLargeMessage = "clipboard text is too large to paste safely"

    public static func isWithinCap(_ byteCount: Int) -> Bool {
        byteCount <= maxBytes
    }
}
