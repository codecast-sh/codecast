// The Lock Screen strip and the Dynamic Island regions.
//
// One session shows in full: the agent's mark, what it is doing, one line of
// detail, and on the right either a running clock (working) or a status
// badge. Several sessions become a list, at most three rows, ordered by who
// needs the human first (the server orders; the widget only draws), with a
// "+N more" line when the strip cannot hold them all.

import SwiftUI
import WidgetKit

struct StripView: View {
    let state: CodecastActivityAttributes.ContentState

    var body: some View {
        Group {
            if state.sessions.count > 1 {
                SessionList(state: state, limit: 3, dense: false)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            } else {
                StripHeader(state: state, detailLines: 2)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
            }
        }
        .widgetURL(state.leadURL)
    }
}

struct StripHeader: View {
    let state: CodecastActivityAttributes.ContentState
    var detailLines: Int = 2

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Mark(session: state.lead, status: state.stripStatus, size: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.headline)
                    .font(Mono.semiBold(15))
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                if let detail = state.detail, !detail.isEmpty {
                    Text(detail)
                        .font(Mono.regular(12))
                        .foregroundStyle(Palette.muted)
                        .lineLimit(detailLines)
                } else if let lead = state.lead, let project = lead.project {
                    Text(project)
                        .font(Mono.regular(12))
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Trailing(state: state)
        }
    }
}

// The right edge of the header: a live clock while one agent works, else the
// word for what the strip needs from you.
struct Trailing: View {
    let state: CodecastActivityAttributes.ContentState

    var body: some View {
        if state.waiting > 0 {
            Badge(text: state.waiting == 1 ? "Waiting" : "\(state.waiting) waiting", tint: Palette.amber)
        } else if state.stripStatus == .failed {
            Badge(text: "Failed", tint: Palette.red)
        } else if state.stripStatus == .done {
            Badge(text: "Done", tint: Palette.green)
        } else if state.sessions.count == 1, let started = state.lead?.started {
            Clock(since: started)
        } else if state.live > 1 {
            Badge(text: "\(state.live) live", tint: Palette.cyan)
        }
    }
}

struct Clock: View {
    let since: Date

    var body: some View {
        Text(since, style: .timer)
            .font(Mono.medium(13))
            .monospacedDigit()
            .foregroundStyle(Palette.muted)
            .multilineTextAlignment(.trailing)
            .frame(maxWidth: 64, alignment: .trailing)
    }
}

struct Badge: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(Mono.medium(11))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(tint.opacity(0.16), in: Capsule())
    }
}

// The agent's two-letter mark with the status dot on its shoulder. Empty
// strips ("All clear") draw the codecast mark instead.
struct Mark: View {
    let session: CodecastActivitySession?
    let status: StripStatus
    var size: CGFloat = 38
    var dotBorder: Color = Palette.ink

    var body: some View {
        let mark = session?.mark ?? AgentMark(agent: "codecast")
        ZStack(alignment: .bottomTrailing) {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(mark.tint.opacity(0.22))
                .overlay(
                    Text(session == nil ? "cc" : mark.letters)
                        .font(Mono.bold(size * 0.38))
                        .foregroundStyle(mark.tint)
                )
                .frame(width: size, height: size)
            Circle()
                .fill(status.tint)
                .frame(width: size * 0.3, height: size * 0.3)
                .overlay(Circle().stroke(dotBorder, lineWidth: 2))
                .offset(x: 3, y: 3)
        }
        .frame(width: size + 3, height: size + 3)
    }
}

struct SessionList: View {
    let state: CodecastActivityAttributes.ContentState
    let limit: Int
    let dense: Bool

    private var shown: Int {
        let total = state.sessions.count + state.hiddenCount
        return total > limit ? limit - 1 : limit
    }

    private var hidden: Int {
        state.hiddenCount + max(0, state.sessions.count - shown)
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(state.sessions.prefix(shown).enumerated()), id: \.element.id) { index, session in
                if index > 0 {
                    Rectangle()
                        .fill(Palette.text.opacity(0.08))
                        .frame(height: 1)
                        .padding(.leading, dense ? 40 : 46)
                }
                SessionRow(session: session, dense: dense)
            }
            if hidden > 0 {
                Rectangle()
                    .fill(Palette.text.opacity(0.08))
                    .frame(height: 1)
                    .padding(.leading, dense ? 40 : 46)
                Text("+\(hidden) more")
                    .font(Mono.regular(11))
                    .foregroundStyle(Palette.dim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, dense ? 40 : 46)
                    .padding(.top, dense ? 4 : 6)
                    .padding(.bottom, dense ? 2 : 4)
            }
        }
    }
}

struct SessionRow: View {
    let session: CodecastActivitySession
    let dense: Bool

    var body: some View {
        let row = HStack(alignment: .center, spacing: 10) {
            Mark(session: session, status: session.stripStatus, size: dense ? 26 : 32, dotBorder: dense ? .black : Palette.ink)
            VStack(alignment: .leading, spacing: 1) {
                Text(session.title)
                    .font(Mono.semiBold(dense ? 13 : 14))
                    .foregroundStyle(Palette.text)
                    .lineLimit(1)
                if let sub = session.detail ?? session.project {
                    Text(sub)
                        .font(Mono.regular(11))
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 6)
            RowTrailing(session: session)
        }
        .padding(.vertical, dense ? 4 : 7)

        if let url = session.url {
            Link(destination: url) { row }
        } else {
            row
        }
    }
}

struct RowTrailing: View {
    let session: CodecastActivitySession

    var body: some View {
        switch session.stripStatus {
        case .working:
            if let started = session.started {
                Text(started, style: .timer)
                    .font(Mono.regular(11))
                    .monospacedDigit()
                    .foregroundStyle(Palette.dim)
                    .frame(maxWidth: 56, alignment: .trailing)
            }
        case .waiting, .done, .failed:
            Image(systemName: session.stripStatus.symbol)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(session.stripStatus.tint)
                .frame(width: 22, height: 22)
                .background(session.stripStatus.tint.opacity(0.16), in: Circle())
        }
    }
}

// The Dynamic Island's trailing pill: the one glyph that says what the strip
// needs, or the live count.
struct IslandTrailing: View {
    let state: CodecastActivityAttributes.ContentState

    var body: some View {
        if state.waiting > 0 {
            Glyph(status: .waiting, count: state.waiting > 1 ? state.waiting : nil)
        } else if state.stripStatus == .failed {
            Glyph(status: .failed, count: nil)
        } else if state.stripStatus == .done {
            Glyph(status: .done, count: nil)
        } else if state.live > 1 {
            Text("\(state.live)")
                .font(Mono.semiBold(13))
                .monospacedDigit()
                .foregroundStyle(Palette.text)
        } else if let started = state.lead?.started {
            Text(started, style: .timer)
                .font(Mono.medium(12))
                .monospacedDigit()
                .foregroundStyle(Palette.text)
                .frame(maxWidth: 52, alignment: .trailing)
        } else {
            Glyph(status: .working, count: nil)
        }
    }

    private struct Glyph: View {
        let status: StripStatus
        let count: Int?

        var body: some View {
            HStack(spacing: 3) {
                if let count { Text("\(count)").font(Mono.semiBold(12)).foregroundStyle(status.tint) }
                Image(systemName: status.symbol)
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(status.tint)
            }
        }
    }
}
