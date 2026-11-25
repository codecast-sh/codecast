import Carbon.HIToolbox

/// An Electron-style accelerator ("CmdOrCtrl+Shift+K") turned into a Carbon
/// key code and modifier mask for RegisterEventHotKey. Policy (how many
/// modifiers a shortcut needs) belongs to the engine; this only parses.
struct Accelerator: Equatable {
    let keyCode: UInt32
    let modifiers: UInt32

    static func parse(_ text: String) -> Accelerator? {
        let parts = text.split(separator: "+", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        guard let key = parts.last, !key.isEmpty, let code = keyCodes[key] else { return nil }
        var modifiers: UInt32 = 0
        for part in parts.dropLast() {
            guard let flag = modifierFlags[part] else { return nil }
            modifiers |= UInt32(flag)
        }
        return Accelerator(keyCode: UInt32(code), modifiers: modifiers)
    }

    var modifierCount: Int {
        [cmdKey, controlKey, optionKey, shiftKey].filter { modifiers & UInt32($0) != 0 }.count
    }

    private static let modifierFlags: [String: Int] = [
        "cmdorctrl": cmdKey, "commandorcontrol": cmdKey, "cmd": cmdKey, "command": cmdKey,
        "super": cmdKey, "meta": cmdKey,
        "ctrl": controlKey, "control": controlKey,
        "alt": optionKey, "option": optionKey, "altgr": optionKey,
        "shift": shiftKey,
    ]

    private static let keyCodes: [String: Int] = {
        var map: [String: Int] = [
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
            "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
            "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
            "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
            "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
            "z": kVK_ANSI_Z,
            "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
            "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            "space": kVK_Space, "tab": kVK_Tab, "enter": kVK_Return, "return": kVK_Return,
            "escape": kVK_Escape, "esc": kVK_Escape, "backspace": kVK_Delete,
            "delete": kVK_ForwardDelete, "up": kVK_UpArrow, "down": kVK_DownArrow,
            "left": kVK_LeftArrow, "right": kVK_RightArrow, "home": kVK_Home, "end": kVK_End,
            "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
            "-": kVK_ANSI_Minus, "minus": kVK_ANSI_Minus, "=": kVK_ANSI_Equal,
            "plus": kVK_ANSI_Equal, ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash,
            ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote, "`": kVK_ANSI_Grave,
            "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket, "\\": kVK_ANSI_Backslash,
        ]
        let fKeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10,
                     kVK_F11, kVK_F12, kVK_F13, kVK_F14, kVK_F15, kVK_F16, kVK_F17, kVK_F18, kVK_F19, kVK_F20]
        for (i, code) in fKeys.enumerated() { map["f\(i + 1)"] = code }
        return map
    }()
}
