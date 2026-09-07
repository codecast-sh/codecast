/// The sixteen codes every helper error and every CLI validation failure
/// carries. The CLI maps each one to a recovery sentence; the helper only ever
/// emits the code and a message.
public enum ComputerErrorCode: String, Sendable, CaseIterable {
    case appNotFound = "app_not_found"
    case appBlocked = "app_blocked"
    case windowNotFound = "window_not_found"
    case windowNotFocused = "window_not_focused"
    case windowStale = "window_stale"
    case providerIncompatible = "provider_incompatible"
    case unsupportedCapability = "unsupported_capability"
    case permissionDenied = "permission_denied"
    case elementNotFound = "element_not_found"
    case elementNotClickable = "element_not_clickable"
    case actionNotSupported = "action_not_supported"
    case valueNotSettable = "value_not_settable"
    case invalidArgument = "invalid_argument"
    case actionTimeout = "action_timeout"
    case screenshotFailed = "screenshot_failed"
    case accessibilityError = "accessibility_error"
}
