import Foundation

/// Whether an action changed the tree, by the same measure the CLI's diff
/// uses (`diffTrees` in src/computer/tree.ts): each element line's depth and
/// body, never its index or the window envelope, plus the focus line as
/// written. The pixel comparison is read only when this says unchanged, so the
/// two have to agree on what a change is.
public enum TreeChange {
    public static func bodyChanged(_ before: String, _ after: String) -> Bool {
        lines(before) != lines(after)
    }

    private static func lines(_ tree: String) -> [Substring] {
        let raw = tree.split(separator: "\n", omittingEmptySubsequences: false)
        guard let blank = raw.firstIndex(where: \.isEmpty) else { return raw }
        return raw[(blank + 1)...].compactMap { line in
            if line.hasPrefix("The focused UI element is ") || line.hasPrefix("No UI element is currently focused") { return line }
            let tabs = line.prefix { $0 == "\t" }
            let rest = line.dropFirst(tabs.count)
            let digits = rest.prefix { $0.isASCII && $0.isNumber }
            if !digits.isEmpty, rest.dropFirst(digits.count).first == " " {
                return tabs + rest.dropFirst(digits.count)
            }
            return tabs.isEmpty ? nil : line
        }
    }
}
