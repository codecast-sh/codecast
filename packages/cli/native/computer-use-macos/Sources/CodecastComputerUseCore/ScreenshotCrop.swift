import CoreGraphics

/// `--crop x,y,w,h`: one region of the window, in window points, read at the
/// display's full pixel density, so text too small to read in the whole-window
/// picture can be read in the zoom.
public enum ScreenshotCrop {
    /// The part of `rect` inside a window of `size`, nil when nothing is left.
    public static func clamp(_ rect: CGRect, to size: CGSize) -> CGRect? {
        guard rect.width > 0, rect.height > 0 else { return nil }
        let clipped = rect.intersection(CGRect(origin: .zero, size: size))
        guard !clipped.isNull, clipped.width >= 1, clipped.height >= 1 else { return nil }
        return clipped
    }

    /// The region in image pixels, whole pixels covering it, inside the image.
    public static func pixelRect(_ rect: CGRect, pixelsPerPoint: Double, imageWidth: Int, imageHeight: Int) -> CGRect {
        let scaled = CGRect(
            x: rect.minX * pixelsPerPoint,
            y: rect.minY * pixelsPerPoint,
            width: rect.width * pixelsPerPoint,
            height: rect.height * pixelsPerPoint
        ).integral
        return scaled.intersection(CGRect(x: 0, y: 0, width: imageWidth, height: imageHeight))
    }
}
