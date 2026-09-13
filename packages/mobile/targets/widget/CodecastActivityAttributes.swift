// The wire contract with the server (packages/shared/contracts/liveActivity.ts).
//
// ActivityKit matches a push-to-start payload to this struct BY NAME
// (`attributes-type`), and decodes `content-state` with a plain Codable, so
// the shape here is the shape the server sends: optional fields absent rather
// than null, dates as ISO strings. Adding an optional field is safe; renaming,
// removing or changing the meaning of one bumps `schemaVersion` on both sides.
//
// This file exists twice on purpose: once in the app's native module (which
// starts activities and reads their tokens) and once in the widget extension
// (which renders them). Extensions cannot link the app's pods, and the two
// Swift modules just need a struct with the same name and Codable shape. A
// test holds the copies byte-identical.

import ActivityKit
import Foundation

public struct CodecastActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable, Sendable {
        public var version: Int
        public var headline: String
        public var detail: String?
        public var status: String
        public var live: Int
        public var waiting: Int
        public var overflow: Int
        public var sessions: [CodecastActivitySession]
        public var updatedAt: String

        public init(
            version: Int = CodecastActivityAttributes.schemaVersion,
            headline: String,
            detail: String? = nil,
            status: String = "working",
            live: Int = 0,
            waiting: Int = 0,
            overflow: Int = 0,
            sessions: [CodecastActivitySession] = [],
            updatedAt: String = ""
        ) {
            self.version = version
            self.headline = headline
            self.detail = detail
            self.status = status
            self.live = live
            self.waiting = waiting
            self.overflow = overflow
            self.sessions = sessions
            self.updatedAt = updatedAt
        }
    }

    public static let schemaVersion = 1

    public init() {}
}

public struct CodecastActivitySession: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var detail: String?
    public var agent: String
    public var project: String?
    public var status: String
    public var startedAt: String
    public var updatedAt: String

    public init(
        id: String,
        title: String,
        detail: String? = nil,
        agent: String = "claude",
        project: String? = nil,
        status: String = "working",
        startedAt: String = "",
        updatedAt: String = ""
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.agent = agent
        self.project = project
        self.status = status
        self.startedAt = startedAt
        self.updatedAt = updatedAt
    }
}
