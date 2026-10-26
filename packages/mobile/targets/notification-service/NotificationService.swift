// Reads a pushed conversation's new rows before iOS shows the push.
//
// The app leaves its backend URL, its access token (shared keychain) and, per
// conversation it has loaded, the newest row it holds (PushPrefetchStore). For
// a push naming one of those conversations this asks the backend for the rows
// after that one and saves them for the app, which merges them the next time it
// opens, so the conversation is current before its socket reconnects. The push
// content is never changed: every path ends by showing it as it came.

import Foundation
import UserNotifications

class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var content: UNNotificationContent?
    private var task: URLSessionDataTask?
    private let lock = NSLock()

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        content = request.content
        guard let conversationId = Self.conversationId(request.content.userInfo) else { return finish("no conversation") }
        guard let token = PushPrefetchStore.token() else { return finish("no token") }
        guard let state = PushPrefetchStore.readState(), let url = URL(string: state.url + "/api/query") else { return finish("no state") }
        guard let after = state.watermarks[conversationId] else { return finish("no watermark") }

        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "path": "conversations:listMessagesTail",
            "args": ["conversation_id": conversationId, "after_timestamp": after],
            "format": "json",
        ])
        task = URLSession.shared.dataTask(with: req) { [weak self] data, response, _ in
            if let data, (response as? HTTPURLResponse)?.statusCode == 200,
               let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               body["status"] as? String == "success",
               let value = body["value"] as? [String: Any],
               let messages = value["messages"] as? [Any], !messages.isEmpty,
               let saved = try? JSONSerialization.data(withJSONObject: [
                   "conversation_id": conversationId,
                   "after_timestamp": after,
                   "messages": messages,
                   "has_more": value["has_more"] as? Bool ?? false,
               ]) {
                PushPrefetchStore.savePrefetch(conversationId: conversationId, json: saved)
                self?.finish("saved \(messages.count) rows")
                return
            }
            self?.finish("nothing saved (status \((response as? HTTPURLResponse)?.statusCode ?? 0))")
        }
        task?.resume()
    }

    override func serviceExtensionTimeWillExpire() {
        task?.cancel()
        finish("timed out")
    }

    private func finish(_ outcome: String) {
        #if DEBUG
        // Debug builds leave the last outcome where a test can read it.
        if let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: PushPrefetchStore.appGroup) {
            try? outcome.write(to: dir.appendingPathComponent("push-prefetch-last.txt"), atomically: true, encoding: .utf8)
        }
        #endif
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        lock.unlock()
        if let handler, let content { handler(content) }
    }

    /// expo-notifications carries the push's data under "body".
    static func conversationId(_ info: [AnyHashable: Any]) -> String? {
        if let body = info["body"] as? [String: Any], let id = body["conversationId"] as? String { return id }
        return info["conversationId"] as? String
    }
}
