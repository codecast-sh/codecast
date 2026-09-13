// Solarized, the app's own palette (packages/mobile/constants/Theme.ts), and
// JetBrains Mono, the app's face. The strip is always dark: it sits on the
// Lock Screen and inside the Dynamic Island, never on a light surface.

import SwiftUI

enum Palette {
    static let ink = Color(red: 0.000, green: 0.169, blue: 0.212)        // #002b36
    static let inkAlt = Color(red: 0.027, green: 0.212, blue: 0.259)     // #073642
    static let text = Color(red: 0.992, green: 0.965, blue: 0.890)       // #fdf6e3
    static let muted = Color(red: 0.576, green: 0.631, blue: 0.631)      // #93a1a1
    static let dim = Color(red: 0.396, green: 0.482, blue: 0.514)        // #657b83
    static let amber = Color(red: 0.710, green: 0.537, blue: 0.000)      // #b58900
    static let red = Color(red: 0.863, green: 0.196, blue: 0.184)        // #dc322f
    static let green = Color(red: 0.522, green: 0.600, blue: 0.000)      // #859900
    static let cyan = Color(red: 0.165, green: 0.631, blue: 0.596)       // #2aa198
    static let blue = Color(red: 0.149, green: 0.545, blue: 0.824)       // #268bd2
    static let orange = Color(red: 0.796, green: 0.294, blue: 0.086)     // #cb4b16
    static let violet = Color(red: 0.424, green: 0.443, blue: 0.769)     // #6c71c4
    static let magenta = Color(red: 0.827, green: 0.212, blue: 0.510)    // #d33682
}

enum Mono {
    static func regular(_ size: CGFloat) -> Font { .custom("JetBrainsMono-Regular", size: size) }
    static func medium(_ size: CGFloat) -> Font { .custom("JetBrainsMono-Medium", size: size) }
    static func semiBold(_ size: CGFloat) -> Font { .custom("JetBrainsMono-SemiBold", size: size) }
    static func bold(_ size: CGFloat) -> Font { .custom("JetBrainsMono-Bold", size: size) }
}

// The strip's vocabulary. `status` on the wire is a string so an older widget
// build renders something sane for a value it has never seen.
enum StripStatus: String {
    case working, waiting, done, failed

    init(wire: String) {
        self = StripStatus(rawValue: wire) ?? .working
    }

    var tint: Color {
        switch self {
        case .working: return Palette.cyan
        case .waiting: return Palette.amber
        case .done: return Palette.green
        case .failed: return Palette.red
        }
    }

    var label: String {
        switch self {
        case .working: return "Working"
        case .waiting: return "Waiting"
        case .done: return "Done"
        case .failed: return "Failed"
        }
    }

    var symbol: String {
        switch self {
        case .working: return "circle.dotted"
        case .waiting: return "hand.raised.fill"
        case .done: return "checkmark"
        case .failed: return "xmark"
        }
    }
}

// Which tool is talking: a two-letter mark in the agent's colour, the way a
// terminal prompt names a host.
struct AgentMark {
    let letters: String
    let tint: Color

    // The wire carries conversations.agent_type verbatim.
    init(agent: String) {
        switch agent {
        case "claude_code", "claude": self = .init(letters: "cl", tint: Palette.orange)
        case "codex": self = .init(letters: "cx", tint: Palette.green)
        case "cursor": self = .init(letters: "cu", tint: Palette.blue)
        case "gemini": self = .init(letters: "ge", tint: Palette.violet)
        case "cowork": self = .init(letters: "cw", tint: Palette.cyan)
        case "opencode": self = .init(letters: "oc", tint: Palette.magenta)
        case "pi": self = .init(letters: "pi", tint: Palette.amber)
        case "grok": self = .init(letters: "gk", tint: Palette.text)
        case "codecast": self = .init(letters: "cc", tint: Palette.amber)
        default: self = .init(letters: String(agent.prefix(2)), tint: Palette.muted)
        }
    }

    private init(letters: String, tint: Color) {
        self.letters = letters
        self.tint = tint
    }
}

enum WireDate {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let whole: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ text: String) -> Date? {
        fractional.date(from: text) ?? whole.date(from: text)
    }
}

extension CodecastActivityAttributes.ContentState {
    var stripStatus: StripStatus { StripStatus(wire: status) }
    var lead: CodecastActivitySession? { sessions.first }
    var leadURL: URL? { lead.flatMap { URL(string: "codecast://session/\($0.id)") } }
    var hiddenCount: Int { overflow }
}

extension CodecastActivitySession {
    var stripStatus: StripStatus { StripStatus(wire: status) }
    var url: URL? { URL(string: "codecast://session/\(id)") }
    var started: Date? { WireDate.parse(startedAt) }
    var mark: AgentMark { AgentMark(agent: agent) }
}
