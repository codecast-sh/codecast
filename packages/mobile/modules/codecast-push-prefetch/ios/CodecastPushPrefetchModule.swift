// The app's side of push prefetch (PushPrefetchStore.swift holds the storage
// both sides share; the extension's side is targets/notification-service).

import ExpoModulesCore

public class CodecastPushPrefetchModule: Module {
    public func definition() -> ModuleDefinition {
        Name("CodecastPushPrefetch")

        Function("setToken") { (token: String?) in
            PushPrefetchStore.setToken(token)
        }

        Function("writeState") { (json: String) -> Bool in
            PushPrefetchStore.writeState(json)
        }

        Function("takeAll") { () -> [String] in
            PushPrefetchStore.takeAll()
        }
    }
}
