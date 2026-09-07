import Foundation

/// Which on screen windows are worth offering as a target.
public enum WindowCandidateFilter {
    public static let minimumEdge: Double = 48
    public static let minimumAlpha: Double = 0.01

    /// A sharing state of zero reads as "this window shares nothing", and the
    /// design filters on it. That reading only holds when the asking process
    /// may see window contents at all: without Screen Recording, macOS reports
    /// zero for nearly every window on the machine and omits every title, so
    /// the filter would discard every candidate and leave the accessibility
    /// tree unreachable even for `--no-screenshot`, which needs nothing but
    /// Accessibility. The field is therefore read only when it says something.
    public static func keeps(
        width: Double,
        height: Double,
        alpha: Double,
        sharingState: Int?,
        screenRecordingGranted: Bool
    ) -> Bool {
        guard width >= minimumEdge, height >= minimumEdge, alpha > minimumAlpha else { return false }
        guard screenRecordingGranted else { return true }
        return sharingState != 0
    }
}
