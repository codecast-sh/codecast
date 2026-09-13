// The app's side of the Lock Screen Live Activity.
//
// ActivityKit hands out two credentials the server needs and nothing else can
// read: the push-to-start token (iOS 17.2+, one per app, lets a push begin an
// activity while the app is closed) and each activity's update token. This
// module streams both to JS as events, and lets JS start an activity locally
// for phones without push-to-start (the app is open, so it can) and end them.
//
// One strip, always: when a new activity appears every older one is ended, so
// a server start and a local start that raced each other settle on one.

import ActivityKit
import ExpoModulesCore

public class CodecastLiveActivityModule: Module {
    private var observing = false

    public func definition() -> ModuleDefinition {
        Name("CodecastLiveActivity")

        Events("onPushToStartToken", "onActivity", "onActivityEnded")

        Constants([
            "environment": Self.environment,
            "supported": Self.supported,
            "supportsPushToStart": Self.supportsPushToStart,
        ])

        Function("isEnabled") { () -> Bool in
            guard #available(iOS 16.2, *) else { return false }
            return ActivityAuthorizationInfo().areActivitiesEnabled
        }

        Function("activityIds") { () -> [String] in
            guard #available(iOS 16.2, *) else { return [] }
            return Activity<CodecastActivityAttributes>.activities.map(\.id)
        }

        AsyncFunction("start") { (state: [String: Any]) -> String? in
            guard #available(iOS 16.2, *) else { return nil }
            let content = try Self.decodeState(state)
            let activity = try Activity.request(
                attributes: CodecastActivityAttributes(),
                content: .init(state: content, staleDate: Date().addingTimeInterval(15 * 60)),
                pushType: .token
            )
            self.adopt(activity, retiringOthers: true)
            return activity.id
        }

        AsyncFunction("update") { (state: [String: Any]) in
            guard #available(iOS 16.2, *) else { return }
            let content = try Self.decodeState(state)
            for activity in Activity<CodecastActivityAttributes>.activities {
                let boxed = Unchecked(activity)
                await boxed.value.update(.init(state: content, staleDate: Date().addingTimeInterval(15 * 60)))
            }
        }

        AsyncFunction("endAll") {
            guard #available(iOS 16.2, *) else { return }
            for activity in Activity<CodecastActivityAttributes>.activities {
                let boxed = Unchecked(activity)
                await boxed.value.end(nil, dismissalPolicy: .immediate)
            }
        }

        OnStartObserving {
            if #available(iOS 16.2, *) { self.beginObserving() }
        }
    }

    // A development build's tokens only work against the sandbox host; the
    // server picks the APNs host per row from this.
    private static var environment: String {
        #if DEBUG
            return "sandbox"
        #else
            return "production"
        #endif
    }

    private static var supported: Bool {
        if #available(iOS 16.2, *) { return true }
        return false
    }

    private static var supportsPushToStart: Bool {
        if #available(iOS 17.2, *) { return true }
        return false
    }

    private static func decodeState(_ state: [String: Any]) throws -> CodecastActivityAttributes.ContentState {
        let data = try JSONSerialization.data(withJSONObject: state)
        return try JSONDecoder().decode(CodecastActivityAttributes.ContentState.self, from: data)
    }

    @available(iOS 16.2, *)
    private func beginObserving() {
        guard !observing else { return }
        observing = true

        if #available(iOS 17.2, *) {
            if let token = Activity<CodecastActivityAttributes>.pushToStartToken {
                sendEvent("onPushToStartToken", ["token": token.hexString])
            }
            Task { [weak self] in
                for await token in Activity<CodecastActivityAttributes>.pushToStartTokenUpdates {
                    self?.sendEvent("onPushToStartToken", ["token": token.hexString])
                }
            }
        }

        // Activities already running when JS starts listening are adopted as
        // they are; only a NEW one retires the others (retiring here would end
        // every existing activity against every other).
        for activity in Activity<CodecastActivityAttributes>.activities {
            adopt(activity, retiringOthers: false)
        }
        Task { [weak self] in
            for await activity in Activity<CodecastActivityAttributes>.activityUpdates {
                self?.adopt(activity, retiringOthers: true)
            }
        }
    }

    @available(iOS 16.2, *)
    private func adopt(_ activity: Activity<CodecastActivityAttributes>, retiringOthers: Bool) {
        let boxed = Unchecked(activity)
        let id = activity.id

        if retiringOthers {
            for other in Activity<CodecastActivityAttributes>.activities where other.id != id {
                let older = Unchecked(other)
                Task { await older.value.end(nil, dismissalPolicy: .immediate) }
            }
        }

        Task { [weak self] in
            if let token = boxed.value.pushToken {
                self?.sendEvent("onActivity", ["id": id, "token": token.hexString])
            }
            for await token in boxed.value.pushTokenUpdates {
                self?.sendEvent("onActivity", ["id": id, "token": token.hexString])
            }
        }
        Task { [weak self] in
            for await state in boxed.value.activityStateUpdates {
                guard state == .ended || state == .dismissed else { continue }
                self?.sendEvent("onActivityEnded", ["id": id])
                return
            }
        }
    }
}

// Activity is not Sendable; the async sequences above are consumed on
// detached tasks, and this box is the documented way to carry one across.
private final class Unchecked<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }
}
