import Foundation

public struct KeyChordError: Error, Equatable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }
}

public enum KeyModifierName: String, Equatable, Sendable, CaseIterable {
    case command
    case control
    case option
    case shift
}

public struct ParsedKeyChord: Equatable, Sendable {
    public let keyCode: UInt16
    public let modifiers: [KeyModifierName]

    public init(keyCode: UInt16, modifiers: [KeyModifierName]) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }
}

/// One chord, parsed once. `press-key` and `hotkey` both land here, and a
/// click's `--modifiers` reuses the modifier half, because a modifier held
/// across two commands would stay logically down for the human if the agent
/// were interrupted between them.
public enum KeyChord {
    public static func parse(_ spec: String) -> Result<ParsedKeyChord, KeyChordError> {
        let parts = spec.split(separator: "+").map { String($0).lowercased() }
        var modifiers: [KeyModifierName] = []
        var keyName: String?
        for part in parts {
            if let modifier = modifier(part) {
                modifiers.append(modifier)
            } else {
                keyName = part
            }
        }
        guard let keyName, let keyCode = codes[keyName] else {
            return .failure(KeyChordError("unsupported key '\(spec)'"))
        }
        return .success(ParsedKeyChord(keyCode: keyCode, modifiers: modifiers))
    }

    public static func parseModifiers(_ spec: String?) -> Result<[KeyModifierName], KeyChordError> {
        guard let spec else { return .success([]) }
        let parts = spec.split(separator: "+", omittingEmptySubsequences: false)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        guard !parts.isEmpty, !parts.contains(where: \.isEmpty) else {
            return .failure(KeyChordError("click modifiers accept modifier keys only, for example CmdOrCtrl or CmdOrCtrl+Shift."))
        }
        var modifiers: [KeyModifierName] = []
        for part in parts {
            guard let modifier = modifier(part) else {
                return .failure(KeyChordError("unsupported click modifier '\(part)'"))
            }
            modifiers.append(modifier)
        }
        return .success(modifiers)
    }

    /// Select all has an accessibility equivalent that needs no focus, so the
    /// helper checks for it before it reaches for synthetic keys.
    public static func isSelectAll(_ key: String) -> Bool {
        let parts = key
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "+")
            .split(separator: "+")
            .map(String.init)
        guard parts.last == "a" else { return false }
        return parts.dropLast().contains { modifier($0) == .command }
    }

    public static func modifier(_ part: String) -> KeyModifierName? {
        switch part {
        case "cmd", "command", "meta", "super", "win", "cmdorctrl", "commandorcontrol":
            return .command
        case "ctrl", "control":
            return .control
        case "alt", "option":
            return .option
        case "shift":
            return .shift
        default:
            return nil
        }
    }

    public static func keyCode(_ name: String) -> UInt16? {
        codes[name.lowercased()]
    }

    public static func modifierKeyCode(_ modifier: KeyModifierName) -> UInt16 {
        switch modifier {
        case .command: return 55
        case .control: return 59
        case .option: return 58
        case .shift: return 56
        }
    }

    private static let codes: [String: UInt16] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
        "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
        "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
        "backspace": 51, "delete": 51, "escape": 53, "esc": 53, "left": 123, "right": 124,
        "down": 125, "up": 126, "insert": 114, "home": 115, "pageup": 116, "page_up": 116,
        "forwarddelete": 117, "end": 119, "pagedown": 121, "page_down": 121,
    ]
}
