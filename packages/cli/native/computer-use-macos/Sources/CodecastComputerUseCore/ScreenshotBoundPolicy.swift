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

    /// The largest picture a model reads without resizing it first: Anthropic
    /// scales anything past a 1568 px long edge or about 1.15 megapixels. A
    /// bigger capture costs bytes and time here and is shrunk there anyway, by
    /// a factor the agent never sees, so the helper shrinks it once and the
    /// reported scale is the true one.
    public static let modelLongEdge: Double = 1568
    public static let modelPixels: Double = 1_150_000

    /// The factor that fits `width` x `height` inside the model's budget, 1 when it already fits.
    public static func modelScale(width: Double, height: Double) -> Double {
        let longEdge = max(width, height, 1)
        let area = max(width * height, 1)
        return min(1, modelLongEdge / longEdge, (modelPixels / area).squareRoot())
    }

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
