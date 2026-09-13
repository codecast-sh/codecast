import ActivityKit
import SwiftUI
import WidgetKit

struct CodecastLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CodecastActivityAttributes.self) { context in
            StripView(state: context.state)
                .activityBackgroundTint(Palette.ink.opacity(0.96))
                .activitySystemActionForegroundColor(Palette.text)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.center) {
                    if state.sessions.count <= 1 {
                        StripHeader(state: state, headlineLines: 1, detailLines: 1)
                            .padding(.horizontal, 4)
                            .padding(.top, 2)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if state.sessions.count > 1 {
                        SessionList(state: state, limit: 3, dense: true)
                            .padding(.horizontal, 2)
                    }
                }
            } compactLeading: {
                Mark(session: state.lead, status: state.stripStatus, size: 20, dotBorder: .black)
                    .padding(.leading, 2)
                    .padding(.trailing, 4)
            } compactTrailing: {
                IslandTrailing(state: state)
                    .padding(.leading, 4)
                    .padding(.trailing, 2)
            } minimal: {
                Mark(session: state.lead, status: state.stripStatus, size: 20, dotBorder: .black)
            }
            .widgetURL(state.leadURL)
            .keylineTint(state.stripStatus.tint)
        }
    }
}
