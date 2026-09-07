import Foundation

/// Everything the renderer needs about one accessibility element, read once by
/// the executable and then reasoned about here. Keeping the rules pure is what
/// makes the tree format testable without a running app.
public struct SnapshotRenderNode: Equatable {
    public var role: String
    public var roleDescription: String?
    public var title: String?
    public var label: String?
    public var linkText: String?
    public var value: String?
    public var placeholder: String?
    public var url: String?
    public var traits: [String]
    public var rawActions: [String]
    public var childCount: Int
    public var summary: String?
    public var rowSummary: String?
    public var webAreaDepth: Int?

    public init(
        role: String,
        roleDescription: String? = nil,
        title: String? = nil,
        label: String? = nil,
        linkText: String? = nil,
        value: String? = nil,
        placeholder: String? = nil,
        url: String? = nil,
        traits: [String] = [],
        rawActions: [String] = [],
        childCount: Int = 0,
        summary: String? = nil,
        rowSummary: String? = nil,
        webAreaDepth: Int? = nil
    ) {
        self.role = role
        self.roleDescription = roleDescription
        self.title = title
        self.label = label
        self.linkText = linkText
        self.value = value
        self.placeholder = placeholder
        self.url = url
        self.traits = traits
        self.rawActions = rawActions
        self.childCount = childCount
        self.summary = summary
        self.rowSummary = rowSummary
        self.webAreaDepth = webAreaDepth
    }
}

public struct SnapshotTabStripCompaction: Equatable {
    public var retainedIndexes: Set<Int>
    public var omittedCount: Int

    public init(retainedIndexes: Set<Int>, omittedCount: Int) {
        self.retainedIndexes = retainedIndexes
        self.omittedCount = omittedCount
    }
}

/// The caps that keep a window inside a prompt.
public enum SnapshotLimits {
    public static let maxNodes = 1200
    public static let maxDepth = 64
    public static let maxRows = 20
    public static let textCollapseSnippetLimit = 8
    public static let textCollapseDepth = 4
    public static let textCollapseMinimumSnippets = 2
    public static let textCollapseMaxLength = 220
    public static let rowSummarySnippetLimit = 6
    public static let rowSummaryDepth = 3
    public static let snippetPreviewLength = 80
    public static let previewLength = 120
    public static let browserTabStripMinimumTabs = 10
}

public enum SnapshotRenderHeuristics {
    public static func supportsAttribute(_ attribute: String, advertisedAttributes: Set<String>?) -> Bool {
        guard let advertisedAttributes else { return true }
        return advertisedAttributes.contains(attribute)
    }

    public static func displayName(_ node: SnapshotRenderNode) -> String? {
        if let title = clean(node.title) {
            return title
        }
        if node.role == "AXLink", let url = clean(node.url), let text = clean(node.linkText ?? node.label ?? node.value) {
            return "[\(markdownEscaped(text))](\(url))"
        }
        if node.role == "AXWebArea" {
            return clean(node.label) ?? clean(node.value)
        }
        if ["AXButton", "AXPopUpButton", "AXImage"].contains(node.role) {
            return clean(node.label)
        }
        if ["AXRow", "AXCell", "AXOutlineRow"].contains(node.role) {
            return clean(node.rowSummary)
        }
        return clean(node.label)
    }

    /// Every element advertises these, so listing them tells the agent nothing
    /// and costs a line's worth of tokens on every node.
    public static func meaningfulActions(_ rawActions: [String], role: String) -> [String] {
        let noisy: Set<String> = [
            "AXPress",
            "AXShowDefaultUI",
            "AXShowAlternateUI",
            "AXShowMenu",
            "AXScrollToVisible",
            "AXConfirm",
            "AXRaise",
        ]
        return rawActions.filter { action in
            if noisy.contains(action) { return false }
            if role == "AXMenu" || role == "AXMenuItem" {
                return action != "AXCancel" && action != "AXPick"
            }
            if role == "AXScrollArea",
               rawActions.contains("AXScrollUpByPage") || rawActions.contains("AXScrollDownByPage"),
               action == "AXScrollLeftByPage" || action == "AXScrollRightByPage" {
                return false
            }
            return true
        }
    }

    /// An unnamed, actionless wrapper carries no information. Skipping it and
    /// promoting its children without consuming an index is what makes the
    /// index space sparse, and why an agent must never guess an index.
    public static func shouldElide(_ node: SnapshotRenderNode) -> Bool {
        guard node.role == "AXGroup" || node.role == "AXUnknown" else { return false }
        guard displayName(node) == nil,
              node.traits.isEmpty,
              meaningfulActions(node.rawActions, role: node.role).isEmpty,
              clean(node.summary) == nil
        else {
            return false
        }
        if node.webAreaDepth != nil, node.childCount > 1 {
            return false
        }
        return true
    }

    public static func shouldSuppressChildren(_ node: SnapshotRenderNode) -> Bool {
        if node.role == "AXMenuBarItem" {
            return true
        }
        let name = displayName(node)
        if node.role == "AXLink", name?.hasPrefix("[") == true {
            return true
        }
        let hasCompactLabel = name != nil || clean(node.value) != nil || clean(node.summary) != nil
        return hasCompactLabel && compactControlRoles.contains(node.role)
    }

    public static func shouldSuppressChildren(role: String, name: String? = nil) -> Bool {
        shouldSuppressChildren(SnapshotRenderNode(role: role, title: name))
    }

    /// Browsers expose every open tab. Keeping only the selected one holds the
    /// snapshot on the current page instead of a wall of stale tab titles.
    public static func tabStripCompaction(
        parent: SnapshotRenderNode,
        children: [SnapshotRenderNode]
    ) -> SnapshotTabStripCompaction? {
        guard isBrowserTabStripContainer(parent) else { return nil }
        let tabIndexes = Set(children.indices.filter { isBrowserTabLike(children[$0]) })
        guard tabIndexes.count >= SnapshotLimits.browserTabStripMinimumTabs else { return nil }

        let selectedTabIndexes = Set(tabIndexes.filter { isSelectedBrowserTab(children[$0]) })
        guard !selectedTabIndexes.isEmpty else { return nil }

        let nonTabIndexes = Set(children.indices.filter { !tabIndexes.contains($0) })
        let retainedIndexes = nonTabIndexes.union(selectedTabIndexes)
        let omittedCount = tabIndexes.count - selectedTabIndexes.count
        guard omittedCount > 0 else { return nil }
        return SnapshotTabStripCompaction(retainedIndexes: retainedIndexes, omittedCount: omittedCount)
    }

    public static func line(index: Int, node: SnapshotRenderNode) -> String {
        let name = displayName(node)
        let roleText = roleText(node)
        let meaningful = meaningfulActions(node.rawActions, role: node.role)
        var line = roleText.isEmpty ? "\(index)" : "\(index) \(roleText)"
        if !node.traits.isEmpty { line += " (\(node.traits.joined(separator: ", ")))" }
        if let name { line += " \(sanitize(name))" }
        if node.role != "AXLink", let description = clean(node.label), description != name {
            line += ", Description: \(sanitize(description))"
        }
        if let valueSegment = formattedValueSegment(roleText: roleText, name: name, value: node.value) {
            line += valueSegment
        }
        if let placeholder = clean(node.placeholder), placeholder != name, placeholder != node.value {
            line += name == nil && clean(node.value) == nil
                ? " Placeholder: \(sanitize(placeholder))"
                : ", Placeholder: \(sanitize(placeholder))"
        }
        if let summary = clean(node.summary), summary != name {
            line += ", Text: \(sanitize(summary))"
        } else if let rowSummary = clean(node.rowSummary), rowSummary != name {
            line += ", Text: \(sanitize(rowSummary))"
        }
        if !meaningful.isEmpty {
            line += ", Secondary Actions: \(meaningful.map(prettyAction).joined(separator: ", "))"
        }
        return line
    }

    public static func roleText(_ node: SnapshotRenderNode) -> String {
        if node.role == "AXGroup" || node.role == "AXUnknown" {
            return "container"
        }
        if node.role == "AXLink" {
            return "link"
        }
        if node.role == "AXWebArea" {
            return clean(node.roleDescription) ?? "html content"
        }
        if node.role == "AXMenuBarItem" {
            return ""
        }
        if let value = clean(node.roleDescription) {
            return value.lowercased()
        }
        if node.role.hasPrefix("AX") {
            return splitCamelCase(String(node.role.dropFirst(2))).lowercased()
        }
        return node.role
    }

    public static func prettyAction(_ action: String) -> String {
        if action == "AXZoomWindow" {
            return "zoom the window"
        }
        let stripped = action.hasPrefix("AX") ? String(action.dropFirst(2)) : action
        return splitCamelCase(stripped.replacingOccurrences(of: "ByPage", with: "")).lowercased()
    }

    public static func sanitize(_ value: String) -> String {
        value.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
    }

    public static func preview(_ value: String, maxLength: Int = SnapshotLimits.previewLength) -> String {
        let clean = sanitize(value)
        if clean.count <= maxLength {
            return clean
        }
        return String(clean.prefix(maxLength)) + "..."
    }

    /// A row set is capped after the visible rows are chosen, so a table with
    /// ten thousand rows still costs at most twenty lines.
    public static func visibleRowSelection(rowsIntersectingParent: [Int], totalRows: Int) -> [Int] {
        let source = rowsIntersectingParent.isEmpty ? Array(0..<totalRows) : rowsIntersectingParent
        return Array(source.prefix(SnapshotLimits.maxRows))
    }

    public static func usesRowsAsPrimaryChildren(role: String) -> Bool {
        ["AXBrowser", "AXList", "AXOutline", "AXTable"].contains(role)
    }

    public static func textCollapseSummary(_ snippets: [String]) -> String? {
        guard snippets.count >= SnapshotLimits.textCollapseMinimumSnippets else { return nil }
        let summary = snippets.joined(separator: " ")
        guard summary.count <= SnapshotLimits.textCollapseMaxLength else { return nil }
        return summary
    }

    static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let sanitized = sanitize(value)
        return sanitized.isEmpty ? nil : sanitized
    }

    private static func formattedValueSegment(roleText: String, name: String?, value: String?) -> String? {
        guard let value = clean(value), value != name else { return nil }
        if roleText == "heading", Int(value) != nil {
            return nil
        }
        let clean = sanitize(value)
        if roleText == "text" || roleText == "text entry area" || roleText == "scroll bar" || roleText == "value indicator" {
            return " \(clean)"
        }
        return ", Value: \(clean)"
    }

    private static func markdownEscaped(_ value: String) -> String {
        sanitize(value)
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "[", with: "\\[")
            .replacingOccurrences(of: "]", with: "\\]")
    }

    private static func isBrowserTabStripContainer(_ node: SnapshotRenderNode) -> Bool {
        let roleText = roleText(node)
        let title = clean(node.title)?.lowercased() ?? ""
        let label = clean(node.label)?.lowercased() ?? ""
        let description = clean(node.roleDescription)?.lowercased() ?? ""
        return roleText == "scroll area" ||
            description == "tab bar" ||
            title == "tab bar" ||
            label == "tab bar"
    }

    private static func isBrowserTabLike(_ node: SnapshotRenderNode) -> Bool {
        let roleDescription = clean(node.roleDescription)?.lowercased() ?? ""
        return node.role == "AXTab" || roleDescription == "tab"
    }

    private static func isSelectedBrowserTab(_ node: SnapshotRenderNode) -> Bool {
        node.traits.contains("selected") || clean(node.value) == "1"
    }

    private static func splitCamelCase(_ value: String) -> String {
        var result = ""
        for character in value {
            if character.isUppercase, !result.isEmpty {
                result.append(" ")
            }
            result.append(character)
        }
        return result
    }

    private static let compactControlRoles: Set<String> = [
        "AXButton",
        "AXCheckBox",
        "AXComboBox",
        "AXDisclosureTriangle",
        "AXHeading",
        "AXMenuItem",
        "AXPopUpButton",
        "AXRadioButton",
        "AXStaticText",
        "AXTab",
    ]
}

/// A rendered tree that only becomes recognizable as a browser tab strip after
/// its children are lines. The second pass edits the lines and drops the
/// records for the tabs it removes, so no index survives without a line.
public enum RenderedBrowserTabCompaction {
    public struct Result: Equatable {
        public var removedLineIndexes: [Int]
        public var insertionIndex: Int
        public var omittedCount: Int

        public init(removedLineIndexes: [Int], insertionIndex: Int, omittedCount: Int) {
            self.removedLineIndexes = removedLineIndexes
            self.insertionIndex = insertionIndex
            self.omittedCount = omittedCount
        }
    }

    public static func plan(lines: [String], from startLine: Int, indent: String) -> Result? {
        let tabLineIndexes = lines.indices.dropFirst(startLine).filter { isDirectTabLine(lines[$0], indent: indent) }
        guard tabLineIndexes.count >= SnapshotLimits.browserTabStripMinimumTabs else { return nil }
        let activeLineIndexes = Set(tabLineIndexes.filter { isActiveTabLine(lines[$0]) })
        guard !activeLineIndexes.isEmpty, let insertionIndex = tabLineIndexes.first else { return nil }
        let removed = tabLineIndexes.filter { !activeLineIndexes.contains($0) }
        guard !removed.isEmpty else { return nil }
        return Result(removedLineIndexes: removed, insertionIndex: insertionIndex, omittedCount: removed.count)
    }

    public static func isDirectTabLine(_ line: String, indent: String) -> Bool {
        guard line.hasPrefix(indent), !line.dropFirst(indent.count).hasPrefix("\t") else {
            return false
        }
        let text = String(line.dropFirst(indent.count))
        return text.range(of: #"^\d+ tab($| \(|,)"#, options: .regularExpression) != nil
    }

    public static func isActiveTabLine(_ line: String) -> Bool {
        line.contains("(selected") || line.contains("Value: 1")
    }

    public static func renderedElementIndex(_ line: String, indent: String) -> Int? {
        let text = line.dropFirst(indent.count)
        return Int(text.prefix { $0 >= "0" && $0 <= "9" })
    }

    public static func omittedLine(indent: String, count: Int) -> String {
        "\(indent)... \(count) inactive browser tabs omitted"
    }
}
